/**
 * LLM Package Generic Turn Loop
 *
 * Purpose:
 * - Provide a host-agnostic iterative model/tool loop for `llm-runtime`.
 *
 * Key features:
 * - Callback-driven loop control with caller-owned generic state.
 * - Optional package-managed model invocation via existing `generate(...)` and `stream(...)`.
 * - Bounded empty-text retry handling and optional plain-text tool-intent normalization.
 *
 * Implementation notes:
 * - The package owns loop repetition and response classification only.
 * - Hosts own persistence, queueing, restore/replay, and tool-execution policy.
 * - No Agent World-specific runtime types are referenced here.
 *
 * Recent changes:
 * - 2026-03-29: Added the first generic `runTurnLoop(...)` API for host-agnostic tool-loop orchestration.
 */

import { generate, stream } from './runtime.js';
import type {
  LLMChatMessage,
  LLMGenerateOptions,
  LLMResponse,
  LLMStreamOptions,
  LLMToolCall,
} from './types.js';

type ParsedToolIntent = {
  toolName: string;
  toolArgs: Record<string, unknown>;
} | null;

export type TurnLoopControl =
  | { control: 'stop' }
  | { control: 'continue'; transientInstruction?: string };

export type TurnLoopTerminalReason =
  | 'text_response'
  | 'tool_calls_response'
  | 'empty_text_stop'
  | 'rejected_text_response'
  | 'unhandled_response'
  | 'max_iterations_exceeded'
  | 'max_tool_rounds_exceeded'
  | 'timeout'
  | 'repeated_tool_call_stopped';

export type TurnLoopStepBranch =
  | 'tool_calls_continue'
  | 'tool_calls_stop'
  | 'text_response_continue'
  | 'text_response_stop'
  | 'rejected_text_retry'
  | 'rejected_text_stop'
  | 'empty_text_retry'
  | 'empty_text_stop'
  | 'unhandled_response_stop'
  | 'max_tool_rounds_stop'
  | 'repeated_tool_call_stop'
  | 'timeout_stop';

export type TurnLoopTextResponseClassification =
  | 'verified_final_response'
  | 'intent_only_narration'
  | 'non_progressing';

export interface TurnLoopTextResponseAssessment {
  classification: TurnLoopTextResponseClassification;
  transientInstruction?: string;
}

export interface TurnLoopStepSummary {
  iteration: number;
  responseKind: LLMResponse['type'];
  branch: TurnLoopStepBranch;
  elapsedMs: number;
  emptyTextRetryCount: number;
  rejectedTextRetryCount: number;
  consecutiveToolTurns: number;
  syntheticToolCallCount: number;
}

export type TurnLoopToolCallSource = 'model' | 'normalized_text_intent';

export interface TurnLoopToolCallSummary {
  iteration: number;
  toolCallId: string;
  toolName: string;
  toolArguments: string;
  normalizedArguments: string;
  toolIndex: number;
  batchSignature: string;
  consecutiveSameBatchCount: number;
  source: TurnLoopToolCallSource;
  synthetic: boolean;
  stoppedByRepeatedGuard: boolean;
}

export interface TurnLoopClassificationSummary {
  iteration: number;
  classification: TurnLoopTextResponseClassification;
  requiresActionEvidence: boolean;
  responseText: string;
  transientInstruction?: string;
  elapsedMs: number;
}

export type TurnLoopRetryKind = 'empty_text' | 'rejected_text';

export interface TurnLoopRetrySummary {
  iteration: number;
  kind: TurnLoopRetryKind;
  decision: 'retry' | 'stop';
  retryCountBefore: number;
  retryCountAfter: number;
  retryLimit: number;
  elapsedMs: number;
  classification?: Exclude<TurnLoopTextResponseClassification, 'verified_final_response'>;
  transientInstruction?: string;
}

export interface TurnLoopRepeatedToolCallStopDetail {
  batchSignature: string;
  consecutiveSameBatchCount: number;
  maxConsecutiveSameBatches: number;
  toolNames: string[];
}

export interface TurnLoopStopMetadata {
  reason: TurnLoopTerminalReason;
  iteration: number;
  elapsedMs: number;
  maxIterations: number;
  maxConsecutiveToolTurns: number;
  maxWallTimeMs: number;
  timedOutDuringIteration?: number;
  repeatedToolCall?: TurnLoopRepeatedToolCallStopDetail;
}

export interface TurnLoopRepeatedToolCallGuard {
  maxConsecutiveSameBatches?: number;
}

export interface TurnLoopIterationStartEvent<TState> {
  state: TState;
  iteration: number;
  elapsedMs: number;
  emptyTextRetryCount: number;
  rejectedTextRetryCount: number;
  consecutiveToolTurns: number;
}

export interface TurnLoopModelResponseEvent<TState, TMessage extends LLMChatMessage = LLMChatMessage> {
  state: TState;
  iteration: number;
  elapsedMs: number;
  messages: TMessage[];
  rawResponse: LLMResponse;
  response: LLMResponse;
  normalizedToolIntent: boolean;
}

export interface TurnLoopClassificationEvent<TState, TMessage extends LLMChatMessage = LLMChatMessage> {
  state: TState;
  iteration: number;
  elapsedMs: number;
  messages: TMessage[];
  response: LLMResponse;
  responseText: string;
  requiresActionEvidence: boolean;
  assessment: TurnLoopTextResponseAssessment;
}

export interface TurnLoopStopEvent<TState> {
  result: RunTurnLoopResult<TState>;
}

export const DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION = 'Do not describe future tool actions. If a tool is needed, emit the tool call now. If prior tool results already contain the answer, reply with the verified final result instead.';
export const DEFAULT_NON_PROGRESSING_TEXT_RECOVERY_INSTRUCTION = 'Your last response did not make progress. If a tool is needed, emit the tool call now. Otherwise reply with the verified final result based on prior tool results.';
export const DEFAULT_TURN_LOOP_MAX_ITERATIONS = 24;
export const DEFAULT_TURN_LOOP_MAX_CONSECUTIVE_TOOL_TURNS = 8;
export const DEFAULT_TURN_LOOP_MAX_WALL_TIME_MS = 120000;
export const DEFAULT_TURN_LOOP_MAX_CONSECUTIVE_SAME_TOOL_CALL_BATCHES = 2;

export type TurnLoopStepResult<TState> = {
  state: TState;
  next?: TurnLoopControl;
};

export type TurnLoopPackageModelRequest =
  | ({ mode?: 'generate' } & Omit<LLMGenerateOptions, 'messages'>)
  | ({ mode: 'stream' } & Omit<LLMStreamOptions, 'messages'>);

export interface RunTurnLoopOptions<TState, TMessage extends LLMChatMessage = LLMChatMessage> {
  initialState: TState;
  emptyTextRetryLimit: number;
  initialEmptyTextRetryCount?: number;
  rejectedTextRetryLimit?: number;
  initialRejectedTextRetryCount?: number;
  maxIterations?: number;
  maxConsecutiveToolTurns?: number;
  maxWallTimeMs?: number;
  repeatedToolCallGuard?: false | TurnLoopRepeatedToolCallGuard;
  markSyntheticToolCalls?: boolean;
  abortSignal?: AbortSignal;
  modelRequest?: TurnLoopPackageModelRequest;
  callModel?: (params: {
    messages: TMessage[];
    abortSignal?: AbortSignal;
    state: TState;
  }) => Promise<LLMResponse>;
  buildMessages: (params: {
    state: TState;
    emptyTextRetryCount: number;
    transientInstruction?: string;
  }) => Promise<TMessage[]>;
  onIterationStart?: (params: TurnLoopIterationStartEvent<TState>) => Promise<void> | void;
  onModelResponse?: (params: TurnLoopModelResponseEvent<TState, TMessage>) => Promise<void> | void;
  onClassification?: (params: TurnLoopClassificationEvent<TState, TMessage>) => Promise<void> | void;
  parsePlainTextToolIntent?: (content: string) => ParsedToolIntent;
  requiresActionEvidence?: (params: {
    state: TState;
    responseText: string;
    response: LLMResponse;
    messages: TMessage[];
    iteration: number;
  }) => Promise<boolean> | boolean;
  classifyTextResponse?: (params: {
    state: TState;
    responseText: string;
    response: LLMResponse;
    messages: TMessage[];
    iteration: number;
    requiresActionEvidence: boolean;
  }) => Promise<TurnLoopTextResponseClassification | TurnLoopTextResponseAssessment | void>
    | TurnLoopTextResponseClassification
    | TurnLoopTextResponseAssessment
    | void;
  onTextResponse: (params: {
    state: TState;
    responseText: string;
    response: LLMResponse;
    messages: TMessage[];
    iteration: number;
  }) => Promise<TurnLoopStepResult<TState> | void>;
  onRejectedTextResponse?: (params: {
    state: TState;
    responseText: string;
    response: LLMResponse;
    messages: TMessage[];
    iteration: number;
    retryCount: number;
    classification: Exclude<TurnLoopTextResponseClassification, 'verified_final_response'>;
    requiresActionEvidence: boolean;
  }) => Promise<TurnLoopStepResult<TState> | void>;
  onToolCallsResponse: (params: {
    state: TState;
    response: LLMResponse;
    messages: TMessage[];
    iteration: number;
  }) => Promise<TurnLoopStepResult<TState> | void>;
  onEmptyTextStop?: (params: {
    state: TState;
    response: LLMResponse;
    messages: TMessage[];
    retryCount: number;
    iteration: number;
  }) => Promise<TurnLoopStepResult<TState> | void>;
  onUnhandledResponse?: (params: {
    state: TState;
    response: LLMResponse;
    messages: TMessage[];
    retryCount: number;
    iteration: number;
  }) => Promise<TurnLoopStepResult<TState> | void>;
  onStop?: (params: TurnLoopStopEvent<TState>) => Promise<void> | void;
}

export interface RunTurnLoopResult<TState> {
  state: TState;
  iterations: number;
  emptyTextRetryCount: number;
  rejectedTextRetryCount: number;
  reason: TurnLoopTerminalReason;
  response: LLMResponse | null;
  elapsedMs: number;
  steps: TurnLoopStepSummary[];
  toolCalls: TurnLoopToolCallSummary[];
  classifications: TurnLoopClassificationSummary[];
  retries: TurnLoopRetrySummary[];
  stop: TurnLoopStopMetadata;
}

const INTENT_ONLY_NARRATION_PATTERN = /^\s*(?:ok(?:ay)?[,:]?\s+|sure[,:]?\s+|next[,:]?\s+|first[,:]?\s+|then[,:]?\s+)?(?:i\s+will|i['’]ll|let\s+me|i\s+am\s+going\s+to|i'm\s+going\s+to)\s+(?:run|check|search|open|update|inspect|read|look\s+for|review|use|call|execute|try|fetch|edit|write|ask)\b/i;

function looksLikeIntentOnlyNarration(content: string): boolean {
  return INTENT_ONLY_NARRATION_PATTERN.test(content.trim());
}

function normalizeTextAssessment(
  assessment: TurnLoopTextResponseClassification | TurnLoopTextResponseAssessment | void,
): TurnLoopTextResponseAssessment | undefined {
  if (!assessment) {
    return undefined;
  }

  if (typeof assessment === 'string') {
    return { classification: assessment };
  }

  return assessment;
}

function getDefaultRejectedTextInstruction(
  classification: Exclude<TurnLoopTextResponseClassification, 'verified_final_response'>,
): string {
  if (classification === 'intent_only_narration') {
    return DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION;
  }

  return DEFAULT_NON_PROGRESSING_TEXT_RECOVERY_INSTRUCTION;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || Number(value) <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(Number(value)));
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeToolArguments(argumentsText: string): string {
  const normalized = String(argumentsText || '').trim();
  if (!normalized) {
    return '{}';
  }

  try {
    return stableStringify(JSON.parse(normalized));
  } catch {
    return normalized;
  }
}

function createToolCallBatchSignature(toolCalls: Array<Pick<TurnLoopToolCallSummary, 'toolName' | 'normalizedArguments' | 'toolIndex' | 'synthetic'>>): string {
  return toolCalls
    .map((toolCall) => `${toolCall.toolIndex}:${toolCall.toolName}:${toolCall.normalizedArguments}:${toolCall.synthetic ? 'synthetic' : 'model'}`)
    .join('|');
}

function relayAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) {
    return () => undefined;
  }

  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }

  const forwardAbort = () => {
    target.abort(source.reason);
  };

  source.addEventListener('abort', forwardAbort, { once: true });
  return () => {
    source.removeEventListener('abort', forwardAbort);
  };
}

function normalizeToolIntentResponse(params: {
  response: LLMResponse;
  parsePlainTextToolIntent?: (content: string) => ParsedToolIntent;
  markSyntheticToolCalls?: boolean;
  nextSyntheticToolCallId: string;
}): { response: LLMResponse; normalizedToolIntent: boolean } {
  const { response, parsePlainTextToolIntent } = params;

  if (
    response.type !== 'text'
    || typeof response.content !== 'string'
    || !response.content.trim()
    || !parsePlainTextToolIntent
  ) {
    return {
      response,
      normalizedToolIntent: false,
    };
  }

  const parsedIntent = parsePlainTextToolIntent(response.content);
  if (!parsedIntent) {
    return {
      response,
      normalizedToolIntent: false,
    };
  }

  const toolCall: LLMToolCall = {
    id: params.nextSyntheticToolCallId,
    type: 'function',
    ...(params.markSyntheticToolCalls ? { synthetic: true } : {}),
    function: {
      name: parsedIntent.toolName,
      arguments: JSON.stringify(parsedIntent.toolArgs || {}),
    },
  };

  return {
    normalizedToolIntent: true,
    response: {
      type: 'tool_calls',
      content: response.content,
      tool_calls: [toolCall],
      assistantMessage: {
        role: 'assistant',
        content: response.content,
        tool_calls: [{ ...toolCall }],
      },
    },
  };
}

function createDefaultModelCaller<TState, TMessage extends LLMChatMessage>(
  request: TurnLoopPackageModelRequest,
): (params: {
  messages: TMessage[];
  abortSignal?: AbortSignal;
  state: TState;
}) => Promise<LLMResponse> {
  return async (params) => {
    if (request.mode === 'stream') {
      return await stream({
        ...request,
        messages: params.messages,
        context: {
          ...(request.context ?? {}),
          abortSignal: request.context?.abortSignal ?? params.abortSignal,
        },
      });
    }

    return await generate({
      ...request,
      messages: params.messages,
      context: {
        ...(request.context ?? {}),
        abortSignal: request.context?.abortSignal ?? params.abortSignal,
      },
    });
  };
}

function resolveModelCaller<TState, TMessage extends LLMChatMessage>(
  options: RunTurnLoopOptions<TState, TMessage>,
): (params: {
  messages: TMessage[];
  abortSignal?: AbortSignal;
  state: TState;
}) => Promise<LLMResponse> {
  if (options.callModel) {
    return options.callModel;
  }

  if (options.modelRequest) {
    return createDefaultModelCaller(options.modelRequest);
  }

  throw new Error('runTurnLoop requires either callModel or modelRequest.');
}

export async function runTurnLoop<TState, TMessage extends LLMChatMessage = LLMChatMessage>(
  options: RunTurnLoopOptions<TState, TMessage>,
): Promise<RunTurnLoopResult<TState>> {
  const callModel = resolveModelCaller(options);
  const maxIterations = normalizePositiveInteger(options.maxIterations, DEFAULT_TURN_LOOP_MAX_ITERATIONS);
  const maxConsecutiveToolTurns = normalizePositiveInteger(
    options.maxConsecutiveToolTurns,
    DEFAULT_TURN_LOOP_MAX_CONSECUTIVE_TOOL_TURNS,
  );
  const maxWallTimeMs = normalizePositiveInteger(options.maxWallTimeMs, DEFAULT_TURN_LOOP_MAX_WALL_TIME_MS);
  const repeatedToolCallGuard = options.repeatedToolCallGuard === false
    ? false
    : {
      maxConsecutiveSameBatches: normalizePositiveInteger(
        options.repeatedToolCallGuard?.maxConsecutiveSameBatches,
        DEFAULT_TURN_LOOP_MAX_CONSECUTIVE_SAME_TOOL_CALL_BATCHES,
      ),
    };
  let state = options.initialState;
  let emptyTextRetryCount = options.initialEmptyTextRetryCount ?? 0;
  let rejectedTextRetryCount = options.initialRejectedTextRetryCount ?? 0;
  let transientInstruction: string | undefined;
  let iterations = 0;
  let consecutiveToolTurns = 0;
  let lastResponse: LLMResponse | null = null;
  let lastToolBatchSignature: string | null = null;
  let consecutiveSameToolBatchCount = 0;
  let syntheticToolCallSequence = 0;
  const startedAt = Date.now();
  const steps: TurnLoopStepSummary[] = [];
  const toolCalls: TurnLoopToolCallSummary[] = [];
  const classifications: TurnLoopClassificationSummary[] = [];
  const retries: TurnLoopRetrySummary[] = [];

  const getElapsedMs = () => Date.now() - startedAt;

  function recordStep(iteration: number, response: LLMResponse, branch: TurnLoopStepBranch): void {
    steps.push({
      iteration,
      responseKind: response.type,
      branch,
      elapsedMs: getElapsedMs(),
      emptyTextRetryCount,
      rejectedTextRetryCount,
      consecutiveToolTurns,
      syntheticToolCallCount: (response.tool_calls ?? []).filter((toolCall) => toolCall.synthetic).length,
    });
  }

  async function finalize(params: {
    reason: TurnLoopTerminalReason;
    response: LLMResponse | null;
    stop: TurnLoopStopMetadata;
  }): Promise<RunTurnLoopResult<TState>> {
    const result: RunTurnLoopResult<TState> = {
      state,
      iterations,
      emptyTextRetryCount,
      rejectedTextRetryCount,
      reason: params.reason,
      response: params.response,
      elapsedMs: getElapsedMs(),
      steps,
      toolCalls,
      classifications,
      retries,
      stop: params.stop,
    };
    await options.onStop?.({ result });
    return result;
  }

  while (true) {
    if (getElapsedMs() >= maxWallTimeMs) {
      return await finalize({
        reason: 'timeout',
        response: lastResponse,
        stop: {
          reason: 'timeout',
          iteration: iterations,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
        },
      });
    }

    if (iterations >= maxIterations) {
      return await finalize({
        reason: 'max_iterations_exceeded',
        response: lastResponse,
        stop: {
          reason: 'max_iterations_exceeded',
          iteration: iterations,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
        },
      });
    }

    const iteration = iterations + 1;
    await options.onIterationStart?.({
      state,
      iteration,
      elapsedMs: getElapsedMs(),
      emptyTextRetryCount,
      rejectedTextRetryCount,
      consecutiveToolTurns,
    });

    const messages = await options.buildMessages({
      state,
      emptyTextRetryCount,
      transientInstruction,
    });
    transientInstruction = undefined;
    iterations = iteration;

    if (getElapsedMs() >= maxWallTimeMs) {
      return await finalize({
        reason: 'timeout',
        response: lastResponse,
        stop: {
          reason: 'timeout',
          iteration,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
          timedOutDuringIteration: iteration,
        },
      });
    }

    const remainingWallTimeMs = maxWallTimeMs - getElapsedMs();
    if (remainingWallTimeMs <= 0) {
      return await finalize({
        reason: 'timeout',
        response: lastResponse,
        stop: {
          reason: 'timeout',
          iteration,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
          timedOutDuringIteration: iteration,
        },
      });
    }

    const modelAbortController = new AbortController();
    const cleanupAbortRelay = relayAbortSignal(options.abortSignal, modelAbortController);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const modelPromise = callModel({
      messages,
      abortSignal: modelAbortController.signal,
      state,
    }).then(
      (response) => ({ kind: 'response' as const, response }),
      (error) => ({ kind: 'error' as const, error }),
    );

    const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        modelAbortController.abort(new Error(`runTurnLoop timed out after ${maxWallTimeMs}ms`));
        resolve({ kind: 'timeout' });
      }, remainingWallTimeMs);
    });

    const modelOutcome = await Promise.race([modelPromise, timeoutPromise]);
    cleanupAbortRelay();
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (modelOutcome.kind === 'timeout') {
      return await finalize({
        reason: 'timeout',
        response: lastResponse,
        stop: {
          reason: 'timeout',
          iteration,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
          timedOutDuringIteration: iteration,
        },
      });
    }

    if (modelOutcome.kind === 'error') {
      throw modelOutcome.error;
    }

    const rawResponse = modelOutcome.response;

    const normalizedResponse = normalizeToolIntentResponse({
      response: rawResponse,
      parsePlainTextToolIntent: options.parsePlainTextToolIntent,
      markSyntheticToolCalls: options.markSyntheticToolCalls,
      nextSyntheticToolCallId: `tool-intent-${++syntheticToolCallSequence}`,
    });
    const response = normalizedResponse.response;
    const normalizedToolIntent = normalizedResponse.normalizedToolIntent;
    lastResponse = response;

    await options.onModelResponse?.({
      state,
      iteration,
      elapsedMs: getElapsedMs(),
      messages,
      rawResponse,
      response,
      normalizedToolIntent,
    });

    if (getElapsedMs() >= maxWallTimeMs) {
      recordStep(iteration, response, 'timeout_stop');
      return await finalize({
        reason: 'timeout',
        response,
        stop: {
          reason: 'timeout',
          iteration,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
          timedOutDuringIteration: iteration,
        },
      });
    }

    if (response.type === 'tool_calls') {
      emptyTextRetryCount = 0;
      rejectedTextRetryCount = 0;
      consecutiveToolTurns += 1;

      const toolCallSource: TurnLoopToolCallSource = normalizedToolIntent ? 'normalized_text_intent' : 'model';
      const batchToolCalls = (response.tool_calls ?? []).map((toolCall, toolIndex) => ({
        iteration,
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        toolArguments: toolCall.function.arguments,
        normalizedArguments: normalizeToolArguments(toolCall.function.arguments),
        toolIndex,
        source: toolCallSource,
        synthetic: Boolean(toolCall.synthetic),
      }));
      const batchSignature = createToolCallBatchSignature(batchToolCalls);
      consecutiveSameToolBatchCount = batchSignature && batchSignature === lastToolBatchSignature
        ? consecutiveSameToolBatchCount + 1
        : 1;
      lastToolBatchSignature = batchSignature;

      const repeatedToolCallStopped = repeatedToolCallGuard !== false
        && consecutiveSameToolBatchCount > repeatedToolCallGuard.maxConsecutiveSameBatches;
      const currentToolCallSummaries = batchToolCalls.map((toolCall) => ({
        ...toolCall,
        batchSignature,
        consecutiveSameBatchCount: consecutiveSameToolBatchCount,
        stoppedByRepeatedGuard: repeatedToolCallStopped,
      }));
      toolCalls.push(...currentToolCallSummaries);

      if (repeatedToolCallStopped) {
        recordStep(iteration, response, 'repeated_tool_call_stop');
        return await finalize({
          reason: 'repeated_tool_call_stopped',
          response,
          stop: {
            reason: 'repeated_tool_call_stopped',
            iteration,
            elapsedMs: getElapsedMs(),
            maxIterations,
            maxConsecutiveToolTurns,
            maxWallTimeMs,
            repeatedToolCall: {
              batchSignature,
              consecutiveSameBatchCount: consecutiveSameToolBatchCount,
              maxConsecutiveSameBatches: repeatedToolCallGuard.maxConsecutiveSameBatches,
              toolNames: currentToolCallSummaries.map((toolCall) => toolCall.toolName),
            },
          },
        });
      }

      if (consecutiveToolTurns > maxConsecutiveToolTurns) {
        recordStep(iteration, response, 'max_tool_rounds_stop');
        return await finalize({
          reason: 'max_tool_rounds_exceeded',
          response,
          stop: {
            reason: 'max_tool_rounds_exceeded',
            iteration,
            elapsedMs: getElapsedMs(),
            maxIterations,
            maxConsecutiveToolTurns,
            maxWallTimeMs,
          },
        });
      }

      const next = await options.onToolCallsResponse({
        state,
        response,
        messages,
        iteration,
      });
      state = next?.state ?? state;
      if (next?.next?.control === 'continue') {
        recordStep(iteration, response, 'tool_calls_continue');
        transientInstruction = next.next.transientInstruction;
        continue;
      }
      recordStep(iteration, response, 'tool_calls_stop');
      return await finalize({
        reason: 'tool_calls_response',
        response,
        stop: {
          reason: 'tool_calls_response',
          iteration,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
        },
      });
    }

    consecutiveToolTurns = 0;
    lastToolBatchSignature = null;
    consecutiveSameToolBatchCount = 0;

    if (response.type === 'text' && String(response.content || '').trim()) {
      const responseText = String(response.content || '');
      const requiresActionEvidence = await options.requiresActionEvidence?.({
        state,
        responseText,
        response,
        messages,
        iteration,
      }) ?? false;
      const explicitAssessment = normalizeTextAssessment(await options.classifyTextResponse?.({
        state,
        responseText,
        response,
        messages,
        iteration,
        requiresActionEvidence,
      }));
      const assessment = explicitAssessment
        ?? {
          classification: requiresActionEvidence && looksLikeIntentOnlyNarration(responseText)
            ? 'intent_only_narration'
            : 'verified_final_response',
        } satisfies TurnLoopTextResponseAssessment;

      classifications.push({
        iteration,
        classification: assessment.classification,
        requiresActionEvidence,
        responseText,
        transientInstruction: assessment.transientInstruction,
        elapsedMs: getElapsedMs(),
      });
      await options.onClassification?.({
        state,
        iteration,
        elapsedMs: getElapsedMs(),
        messages,
        response,
        responseText,
        requiresActionEvidence,
        assessment,
      });

      if (assessment.classification === 'verified_final_response') {
        emptyTextRetryCount = 0;
        rejectedTextRetryCount = 0;
        const next = await options.onTextResponse({
          state,
          responseText,
          response,
          messages,
          iteration,
        });
        state = next?.state ?? state;
        if (next?.next?.control === 'continue') {
          recordStep(iteration, response, 'text_response_continue');
          transientInstruction = next.next.transientInstruction;
          continue;
        }
        recordStep(iteration, response, 'text_response_stop');
        return await finalize({
          reason: 'text_response',
          response,
          stop: {
            reason: 'text_response',
            iteration,
            elapsedMs: getElapsedMs(),
            maxIterations,
            maxConsecutiveToolTurns,
            maxWallTimeMs,
          },
        });
      }

      const next = await options.onRejectedTextResponse?.({
        state,
        responseText,
        response,
        messages,
        iteration,
        retryCount: rejectedTextRetryCount,
        classification: assessment.classification,
        requiresActionEvidence,
      });
      state = next?.state ?? state;
      const rejectedTextRetryLimit = options.rejectedTextRetryLimit ?? 0;

      if (rejectedTextRetryCount < rejectedTextRetryLimit && next?.next?.control !== 'stop') {
        const retryCountBefore = rejectedTextRetryCount;
        rejectedTextRetryCount += 1;
        transientInstruction = next?.next?.control === 'continue'
          ? (next.next.transientInstruction
            ?? assessment.transientInstruction
            ?? getDefaultRejectedTextInstruction(assessment.classification))
          : (assessment.transientInstruction ?? getDefaultRejectedTextInstruction(assessment.classification));
        retries.push({
          iteration,
          kind: 'rejected_text',
          decision: 'retry',
          retryCountBefore,
          retryCountAfter: rejectedTextRetryCount,
          retryLimit: rejectedTextRetryLimit,
          elapsedMs: getElapsedMs(),
          classification: assessment.classification,
          transientInstruction,
        });
        recordStep(iteration, response, 'rejected_text_retry');
        continue;
      }

      retries.push({
        iteration,
        kind: 'rejected_text',
        decision: 'stop',
        retryCountBefore: rejectedTextRetryCount,
        retryCountAfter: rejectedTextRetryCount,
        retryLimit: rejectedTextRetryLimit,
        elapsedMs: getElapsedMs(),
        classification: assessment.classification,
      });
      recordStep(iteration, response, 'rejected_text_stop');
      return await finalize({
        reason: 'rejected_text_response',
        response,
        stop: {
          reason: 'rejected_text_response',
          iteration,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
        },
      });
    }

    if (response.type === 'text' && emptyTextRetryCount < options.emptyTextRetryLimit) {
      const retryCountBefore = emptyTextRetryCount;
      emptyTextRetryCount += 1;
      retries.push({
        iteration,
        kind: 'empty_text',
        decision: 'retry',
        retryCountBefore,
        retryCountAfter: emptyTextRetryCount,
        retryLimit: options.emptyTextRetryLimit,
        elapsedMs: getElapsedMs(),
      });
      recordStep(iteration, response, 'empty_text_retry');
      continue;
    }

    if (response.type === 'text') {
      const next = await options.onEmptyTextStop?.({
        state,
        response,
        messages,
        retryCount: emptyTextRetryCount,
        iteration,
      });
      state = next?.state ?? state;
      retries.push({
        iteration,
        kind: 'empty_text',
        decision: 'stop',
        retryCountBefore: emptyTextRetryCount,
        retryCountAfter: emptyTextRetryCount,
        retryLimit: options.emptyTextRetryLimit,
        elapsedMs: getElapsedMs(),
      });
      recordStep(iteration, response, 'empty_text_stop');
      return await finalize({
        reason: 'empty_text_stop',
        response,
        stop: {
          reason: 'empty_text_stop',
          iteration,
          elapsedMs: getElapsedMs(),
          maxIterations,
          maxConsecutiveToolTurns,
          maxWallTimeMs,
        },
      });
    }

    const next = await options.onUnhandledResponse?.({
      state,
      response,
      messages,
      retryCount: emptyTextRetryCount,
      iteration,
    });
    state = next?.state ?? state;
    recordStep(iteration, response, 'unhandled_response_stop');
    return await finalize({
      reason: 'unhandled_response',
      response,
      stop: {
        reason: 'unhandled_response',
        iteration,
        elapsedMs: getElapsedMs(),
        maxIterations,
        maxConsecutiveToolTurns,
        maxWallTimeMs,
      },
    });
  }
}
