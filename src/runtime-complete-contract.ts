/**
 * Runtime completion contract helpers.
 *
 * Purpose:
 * - Define the public runtime-facade completion result and event shapes.
 * - Provide helpers for resuming `ask_user_input` flows after a human answers.
 *
 * Key features:
 * - Stable `complete()` and `streamComplete()` result/event contracts for the runtime facade.
 * - Public helpers for converting host-owned human answers into tool-result messages.
 *
 * Implementation notes:
 * - Keeps the runtime-facade contract independent from any specific loop implementation.
 * - Uses package-native chat/tool types so runtime callers stay on one message model.
 *
 * Recent changes:
 * - 2026-07-28: Added validated human-input outcomes and terminal tool-approval cancellation.
 * - 2026-05-26: Added a generic tool_calls runtime status for host-owned tool-call handling without a HITL-specific wait state.
 * - 2026-05-15: Moved runtime completion result/event contracts and HITL resume helpers out of the deleted legacy agentic loop module.
 */

import type { LLMChatMessage, LLMToolCall } from './types.js';

export type RuntimeCompleteStatus =
  | 'completed'
  | 'tool_calls'
  | 'cancelled'
  | 'failed'
  | 'max_iterations';

export interface PendingHumanInput {
  toolCallId: string;
  toolName: string;
  request: unknown;
}

export type AskUserInputCancellationReason =
  | 'rejected'
  | 'skipped'
  | 'dismissed'
  | 'timeout'
  | 'invalid';

export type AskUserInputRawResponse =
  | {
    status: 'answered';
    answers: Record<string, string | string[]>;
  }
  | {
    status: 'cancelled';
    reason: Exclude<AskUserInputCancellationReason, 'invalid'>;
    message?: string;
  };

export interface AskUserInputAnsweredOutcome {
  status: 'answered';
  answers: Record<string, string | string[]>;
}

export interface AskUserInputCancelledOutcome {
  status: 'cancelled';
  reason: AskUserInputCancellationReason;
  message?: string;
}

export type AskUserInputOutcome =
  | AskUserInputAnsweredOutcome
  | AskUserInputCancelledOutcome;

export type RuntimeToolApprovalCancellationReason =
  | 'approval_rejected'
  | 'approval_dismissed'
  | 'approval_timeout'
  | 'approval_invalid'
  | 'approval_callback_error';

export interface RuntimeToolApprovalCancellation {
  kind: 'tool_approval';
  reason: RuntimeToolApprovalCancellationReason;
  toolCall: LLMToolCall;
  message?: string;
}

export type RuntimeCancellation = RuntimeToolApprovalCancellation;

export interface RuntimeCompleteResult {
  status: RuntimeCompleteStatus;
  messages: LLMChatMessage[];
  output?: string | null;
  toolCalls?: LLMToolCall[];
  cancellation?: RuntimeCancellation;
  error?: string;
  raw?: unknown;
}

export type RuntimeStreamCompleteEvent =
  | { type: 'model_start'; iteration: number }
  | { type: 'assistant_message'; message: LLMChatMessage; iteration: number }
  | { type: 'text_delta'; delta: string; iteration: number }
  | { type: 'reasoning_delta'; delta: string; iteration: number }
  | {
    type: 'tool_call_delta';
    toolCallId?: string;
    toolName?: string;
    argumentsDelta: string;
    index: number;
    iteration: number;
  }
  | { type: 'answer_delta'; delta: string; iteration: number }
  | { type: 'tool_start'; toolCall: LLMToolCall; args: unknown; iteration: number }
  | { type: 'tool_result'; toolCall: LLMToolCall; result: unknown; iteration: number }
  | { type: 'tool_error'; toolCall: LLMToolCall; error: string; iteration: number }
  | { type: 'tool_calls'; result: RuntimeCompleteResult; iteration: number }
  | { type: 'cancelled'; result: RuntimeCompleteResult; iteration: number }
  | { type: 'completed'; result: RuntimeCompleteResult; iteration: number }
  | { type: 'failed'; result: RuntimeCompleteResult; iteration: number }
  | { type: 'raw'; raw: unknown; iteration: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return false;
    }

    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor
        && descriptor.enumerable
        && 'value' in descriptor,
      );
    });
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Reflect.ownKeys(value).every((key) => (
    typeof key === 'string' && allowed.has(key)
  ));
}

function invalidHumanInput(message: string): AskUserInputCancelledOutcome {
  return {
    status: 'cancelled',
    reason: 'invalid',
    message,
  };
}

export function normalizeAskUserInputOutcome(
  pending: PendingHumanInput,
  rawResponse: unknown,
): AskUserInputOutcome {
  if (!isPlainDataRecord(pending.request)) {
    return invalidHumanInput('ask_user_input request must be an object.');
  }

  const selectionType = !Object.hasOwn(pending.request, 'type')
    ? 'single-select'
    : pending.request.type;
  if (selectionType !== 'single-select' && selectionType !== 'multiple-select') {
    return invalidHumanInput('ask_user_input request type must be single-select or multiple-select.');
  }

  if (
    !Object.hasOwn(pending.request, 'questions')
    || !Array.isArray(pending.request.questions)
    || pending.request.questions.length === 0
  ) {
    return invalidHumanInput('ask_user_input request must contain at least one question.');
  }

  const questions = new Map<string, {
    optionIds: Set<string>;
    allowOther: boolean;
  }>();
  for (const question of pending.request.questions) {
    if (
      !isPlainDataRecord(question)
      || !Object.hasOwn(question, 'id')
      || typeof question.id !== 'string'
      || !question.id.trim()
    ) {
      return invalidHumanInput('Every ask_user_input question must have a non-empty id.');
    }
    if (questions.has(question.id)) {
      return invalidHumanInput(`Duplicate ask_user_input question id: ${question.id}`);
    }
    if (
      !Object.hasOwn(question, 'options')
      || !Array.isArray(question.options)
      || question.options.length < 2
    ) {
      return invalidHumanInput(`Question "${question.id}" must contain at least two options.`);
    }

    const optionIds = new Set<string>();
    for (const option of question.options) {
      if (
        !isPlainDataRecord(option)
        || !Object.hasOwn(option, 'id')
        || typeof option.id !== 'string'
        || !option.id.trim()
      ) {
        return invalidHumanInput(`Question "${question.id}" contains an option without a non-empty id.`);
      }
      if (optionIds.has(option.id)) {
        return invalidHumanInput(`Question "${question.id}" contains duplicate option id: ${option.id}`);
      }
      optionIds.add(option.id);
    }

    const allowOther = Object.hasOwn(question, 'allowOther') && question.allowOther === true;
    if (selectionType === 'multiple-select' && allowOther) {
      return invalidHumanInput(`Question "${question.id}" cannot enable allowOther for multiple-select input.`);
    }
    questions.set(question.id, { optionIds, allowOther });
  }

  if (
    !isPlainDataRecord(rawResponse)
    || !Object.hasOwn(rawResponse, 'status')
    || typeof rawResponse.status !== 'string'
  ) {
    return invalidHumanInput('Human input response must be an answered or cancelled outcome.');
  }

  if (rawResponse.status === 'cancelled') {
    if (!hasOnlyKeys(rawResponse, ['status', 'reason', 'message'])) {
      return invalidHumanInput('Cancelled human input contains unknown fields.');
    }
    if (
      rawResponse.reason !== 'rejected'
      && rawResponse.reason !== 'skipped'
      && rawResponse.reason !== 'dismissed'
      && rawResponse.reason !== 'timeout'
    ) {
      return invalidHumanInput('Cancelled human input has an invalid reason.');
    }
    const hasMessage = Object.hasOwn(rawResponse, 'message');
    if (hasMessage && typeof rawResponse.message !== 'string') {
      return invalidHumanInput('Cancelled human input message must be a string.');
    }
    return {
      status: 'cancelled',
      reason: rawResponse.reason,
      ...(hasMessage && rawResponse.message
        ? { message: rawResponse.message as string }
        : {}),
    };
  }

  if (
    rawResponse.status !== 'answered'
    || !hasOnlyKeys(rawResponse, ['status', 'answers'])
    || !Object.hasOwn(rawResponse, 'answers')
    || !isPlainDataRecord(rawResponse.answers)
  ) {
    return invalidHumanInput('Answered human input must contain only status and an answers object.');
  }

  const answerIds = Object.keys(rawResponse.answers);
  if (answerIds.length !== questions.size || answerIds.some((id) => !questions.has(id))) {
    return invalidHumanInput('Answered human input must answer every declared question exactly once.');
  }

  const normalizedAnswers = Object.create(null) as Record<string, string | string[]>;
  for (const [questionId, question] of questions) {
    const answer = rawResponse.answers[questionId];
    if (selectionType === 'single-select') {
      if (typeof answer !== 'string' || !answer.trim()) {
        return invalidHumanInput(`Question "${questionId}" requires one non-empty string answer.`);
      }
      if (!question.optionIds.has(answer) && !question.allowOther) {
        return invalidHumanInput(`Question "${questionId}" does not allow free-form answers.`);
      }
      normalizedAnswers[questionId] = answer;
      continue;
    }

    if (!Array.isArray(answer) || answer.length === 0) {
      return invalidHumanInput(`Question "${questionId}" requires at least one selected option.`);
    }
    const selectedIds = new Set<string>();
    for (const selectedId of answer) {
      if (
        typeof selectedId !== 'string'
        || !selectedId.trim()
        || !question.optionIds.has(selectedId)
      ) {
        return invalidHumanInput(`Question "${questionId}" contains an invalid selected option.`);
      }
      if (selectedIds.has(selectedId)) {
        return invalidHumanInput(`Question "${questionId}" contains duplicate selected options.`);
      }
      selectedIds.add(selectedId);
    }
    normalizedAnswers[questionId] = [...selectedIds];
  }

  return {
    status: 'answered',
    answers: normalizedAnswers,
  };
}

export function createHumanInputToolResult(
  pending: PendingHumanInput,
  answer: AskUserInputAnsweredOutcome,
): LLMChatMessage {
  return {
    role: 'tool',
    tool_call_id: pending.toolCallId,
    ...(pending.toolName ? { name: pending.toolName } : {}),
    content: JSON.stringify(answer),
  } as LLMChatMessage;
}

export function createAskUserInputResult(
  pending: PendingHumanInput,
  answer: AskUserInputAnsweredOutcome,
): LLMChatMessage {
  return createHumanInputToolResult(pending, answer);
}
