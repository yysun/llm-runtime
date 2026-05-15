/**
 * Runtime completion contract helpers.
 *
 * Purpose:
 * - Define the public runtime-facade completion result and event shapes.
 * - Provide helpers for resuming `ask_user_input` flows after a human answers.
 *
 * Key features:
 * - Stable `complete()` and `streamComplete()` result/event contracts for the runtime facade.
 * - Public helpers for converting human answers into tool-result messages.
 *
 * Implementation notes:
 * - Keeps the runtime-facade contract independent from any specific loop implementation.
 * - Uses package-native chat/tool types so runtime callers stay on one message model.
 *
 * Recent changes:
 * - 2026-05-15: Moved runtime completion result/event contracts and HITL resume helpers out of the deleted legacy agentic loop module.
 */

import type { LLMChatMessage, LLMToolCall } from './types.js';

export type RuntimeCompleteStatus = 'completed' | 'waiting_for_human' | 'failed' | 'max_iterations';

export interface PendingHumanInput {
  toolCallId: string;
  toolName: string;
  request: unknown;
}

export interface RuntimeCompleteResult {
  status: RuntimeCompleteStatus;
  messages: LLMChatMessage[];
  output?: string | null;
  pendingHumanInput?: PendingHumanInput;
  error?: string;
  raw?: unknown;
}

export type RuntimeStreamCompleteEvent =
  | { type: 'model_start'; iteration: number }
  | { type: 'assistant_message'; message: LLMChatMessage; iteration: number }
  | { type: 'text_delta'; delta: string; iteration: number }
  | { type: 'tool_start'; toolCall: LLMToolCall; args: unknown; iteration: number }
  | { type: 'tool_result'; toolCall: LLMToolCall; result: unknown; iteration: number }
  | { type: 'tool_error'; toolCall: LLMToolCall; error: string; iteration: number }
  | { type: 'waiting_for_human'; pendingHumanInput: PendingHumanInput; messages: LLMChatMessage[]; iteration: number }
  | { type: 'completed'; result: RuntimeCompleteResult; iteration: number }
  | { type: 'failed'; result: RuntimeCompleteResult; iteration: number }
  | { type: 'raw'; raw: unknown; iteration: number };

export function createHumanInputToolResult(
  pending: PendingHumanInput,
  answer: unknown,
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
  answer: unknown,
): LLMChatMessage {
  return createHumanInputToolResult(pending, answer);
}
