/**
 * LLM Package Generic Completion Loop
 *
 * Purpose:
 * - Provide a host-agnostic iterative model/tool completion loop for `llm-runtime`.
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
 * - 2026-05-15: Added read-only-before-HITL prompt guidance and default rejection of unsupported evidence claims without action evidence.
 * - 2026-05-15: Stopped default plain-text retries while interaction requests are still unanswered and strengthened post-answer recovery instructions.
 * - 2026-05-15: Separated human-interaction progress from action evidence in `complete(...)` and exposed evidence metadata in loop traces.
 * - 2026-05-15: Added bound tool executors for package-managed completion loops and guarded malformed control retries with normal tool-loop stop checks.
 * - 2026-05-15: Made completion evidence run-scoped, merged the loop contract into the first system message, and rejected malformed control-tool payloads.
 * - 2026-05-15: Added agent-mode control tools and deterministic stop handling for final answers, user-input requests, and blocked outcomes.
 * - 2026-05-15: Added a package-owned completion-loop system prompt, evidence-based recovery wording, and stronger default rejected-text retries.
 * - 2026-05-15: Renamed the preferred public loop APIs to `complete(...)` and `runCompletionLoop(...)` while preserving deprecated aliases.
 * - 2026-05-15: Added package-owned default text response handling for `complete(...)` before any observed tool result.
 * - 2026-03-29: Added the first generic completion-loop API for host-agnostic tool-loop orchestration.
 */

import { executeToolCall, executeToolCalls, generate, stream } from './runtime.js';
import type {
  LLMChatMessage,
  LLMExecuteToolCallOptions,
  LLMGenerateOptions,
  LLMResponse,
  LLMStreamOptions,
  LLMToolDefinition,
  LLMToolEvidenceKind,
  LLMToolCall,
  LLMToolExecutionContext,
  LLMToolExecutionErrorMode,
} from './types.js';

type ParsedToolIntent = {
  toolName: string;
  toolArgs: Record<string, unknown>;
} | null;

export const AGENT_CONTROL_TOOL_NAMES = [
  'final_answer',
  'need_user_input',
  'blocked',
] as const;

export type AgentControlToolName = typeof AGENT_CONTROL_TOOL_NAMES[number];

const AGENT_CONTROL_TOOL_NAME_SET = new Set<string>(AGENT_CONTROL_TOOL_NAMES);
const INTERACTION_TOOL_NAME_SET = new Set<string>([
  'ask_user_input',
  'ask_user_question',
  'human_intervention_request',
]);
const READ_EVIDENCE_TOOL_NAME_SET = new Set<string>([
  'load_skill',
  'web_fetch',
  'read_file',
  'list_files',
  'search_files',
  'path_exists',
]);
const WRITE_EVIDENCE_TOOL_NAME_SET = new Set<string>([
  'write_file',
  'create_directory',
]);
const EXTERNAL_ACTION_TOOL_NAME_SET = new Set<string>([
  'shell_cmd',
]);

export type TurnLoopControl =
  | { control: 'stop' }
  | { control: 'continue'; transientInstruction?: string };

export type TurnLoopTerminalReason =
  | 'text_response'
  | 'final_answer'
  | 'needs_user_input'
  | 'blocked'
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
  | 'final_answer_stop'
  | 'needs_user_input_stop'
  | 'blocked_stop'
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
  | 'unsupported_evidence_claim'
  | 'non_progressing';

export type TurnLoopDefaultTextResponseMode = 'permissive' | 'require_tool_result';

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
  evidenceKind: LLMToolEvidenceKind;
  countsAsActionEvidence: boolean;
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
  observedInteractionProgress: boolean;
  observedActionEvidence: boolean;
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
  controlOutput?: TurnLoopControlOutput;
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
  result: RunCompletionLoopResult<TState>;
}

export interface TurnLoopFinalAnswerControlOutput {
  kind: 'final_answer';
  toolCallId: string;
  answer: string;
  evidenceRefs: string[];
}

export interface TurnLoopNeedUserInputControlOutput {
  kind: 'need_user_input';
  toolCallId: string;
  question: string;
  reason: string;
}

export interface TurnLoopBlockedControlOutput {
  kind: 'blocked';
  toolCallId: string;
  reason: string;
}

export type TurnLoopControlOutput =
  | TurnLoopFinalAnswerControlOutput
  | TurnLoopNeedUserInputControlOutput
  | TurnLoopBlockedControlOutput;

export interface TurnLoopControlToolCallEvent<TState, TMessage extends LLMChatMessage = LLMChatMessage> {
  state: TState;
  controlOutput: TurnLoopControlOutput;
  response: LLMResponse;
  messages: TMessage[];
  iteration: number;
}

export const DEFAULT_AGENT_RUN_LOOP_SYSTEM_PROMPT = [
  'You are operating inside an agent run loop.',
  '',
  'You may briefly tell the user what you are about to do, but narration is not completion.',
  '',
  'If the task requires workspace inspection, tool use, file access, search, command execution, or external lookup, you must call the appropriate tool.',
  '',
  'For read-only inspection, lookup, search, summarization, and analysis, call the appropriate read-only tool without asking for confirmation.',
  '',
  'Do not ask the user to disambiguate before performing a safe broad search. If multiple entity types, locations, files, or records could match, search broadly first and present matches.',
  '',
  'Use ask_user_input only when the missing input cannot be safely discovered through read-only tools, or when the next step requires approval, preference, or a side effect.',
  '',
  'Stop only by:',
  '- calling tools,',
  '- producing a final answer supported by run evidence,',
  '- requesting required missing user input,',
  '- reporting a permission or safety block.',
  '',
  'If you call a human-interaction tool such as ask_user_input, do not restate the same question in plain assistant text while waiting.',
  'After the user answers, use that answer immediately and call the next task tool in the same turn unless the task is already complete.',
  '',
  'Do not stop after merely announcing intent.',
].join('\n');
export const DEFAULT_COMPLETION_LOOP_SYSTEM_PROMPT = DEFAULT_AGENT_RUN_LOOP_SYSTEM_PROMPT;
export const COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG = 'llm-runtime-loop-contract';
export const DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION = 'The last response announced work but did not complete the task with the required evidence. Continue now. If work is needed, call the appropriate tool in this turn. If prior tool results already contain enough evidence, provide the final answer based on those results.';
export const DEFAULT_UNSUPPORTED_EVIDENCE_CLAIM_RECOVERY_INSTRUCTION = 'The last response claimed search, inspection, or other tool-backed results without run evidence. Do not claim unsupported results. Call the appropriate tool now, or answer only from existing tool results.';
export const DEFAULT_NON_PROGRESSING_TEXT_RECOVERY_INSTRUCTION = 'The last response did not complete the task with the required evidence. Continue now. If work is needed, call the appropriate tool. If prior tool results already contain enough evidence, provide the final answer based on those results.';
export const DEFAULT_POST_INTERACTION_RECOVERY_INSTRUCTION = 'The user already answered the interaction request. Do not ask the same question again and do not narrate unverified results. Use the user\'s answer now and call the appropriate task tool in this turn.';
export const DEFAULT_WAITING_FOR_INTERACTION_RESOLUTION_INSTRUCTION = 'You already requested required user input. Do not repeat the same question in assistant text and do not call the same interaction tool again before the user answers. Wait for the user answer, then continue with the appropriate task tool.';
export const DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION = 'The last response did not follow the agent run loop protocol. Continue now. Call the appropriate workspace tool, or use final_answer, need_user_input, or blocked.';
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

export interface TurnLoopBoundToolExecutorOptions {
  errorMode?: LLMToolExecutionErrorMode;
}

export interface TurnLoopToolExecutor {
  executeToolCall: (
    toolCall: LLMToolCall,
    context?: LLMToolExecutionContext,
    options?: TurnLoopBoundToolExecutorOptions
  ) => Promise<unknown>;
  executeToolCalls: (
    toolCalls: LLMToolCall[],
    context?: LLMToolExecutionContext,
    options?: TurnLoopBoundToolExecutorOptions
  ) => Promise<unknown[]>;
}

export interface RunCompletionLoopOptions<TState, TMessage extends LLMChatMessage = LLMChatMessage> {
  initialState: TState;
  emptyTextRetryLimit: number;
  initialEmptyTextRetryCount?: number;
  rejectedTextRetryLimit?: number;
  initialRejectedTextRetryCount?: number;
  defaultTextResponseMode?: TurnLoopDefaultTextResponseMode;
  agentControlMode?: boolean;
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
    toolExecutor?: TurnLoopToolExecutor;
  }) => Promise<TurnLoopStepResult<TState> | void>;
  onFinalAnswerToolCall?: (params: TurnLoopControlToolCallEvent<TState, TMessage>) => Promise<TurnLoopStepResult<TState> | void>;
  onNeedUserInputToolCall?: (params: TurnLoopControlToolCallEvent<TState, TMessage>) => Promise<TurnLoopStepResult<TState> | void>;
  onBlockedToolCall?: (params: TurnLoopControlToolCallEvent<TState, TMessage>) => Promise<TurnLoopStepResult<TState> | void>;
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

export type CompleteOptions<TState, TMessage extends LLMChatMessage = LLMChatMessage> =
  Omit<RunCompletionLoopOptions<TState, TMessage>, 'emptyTextRetryLimit'> & {
    emptyTextRetryLimit?: number;
  };

export interface RunCompletionLoopResult<TState> {
  state: TState;
  iterations: number;
  emptyTextRetryCount: number;
  rejectedTextRetryCount: number;
  controlOutput: TurnLoopControlOutput | null;
  reason: TurnLoopTerminalReason;
  response: LLMResponse | null;
  elapsedMs: number;
  steps: TurnLoopStepSummary[];
  toolCalls: TurnLoopToolCallSummary[];
  classifications: TurnLoopClassificationSummary[];
  retries: TurnLoopRetrySummary[];
  stop: TurnLoopStopMetadata;
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

function isUnsupportedEvidenceClaim(responseText: string): boolean {
  const normalizedText = String(responseText || '').trim().toLowerCase();
  if (!normalizedText) {
    return false;
  }

  const evidenceVerbPattern = /\b(i|we)\s+(searched|checked|looked up|looked|inspected|read|reviewed|scanned|queried|examined|verified|found)\b/;
  const noResultsPattern = /\b(?:no|there (?:is|are) no|found no)\s+(?:exact\s+)?(?:match(?:es)?|matching\s+(?:records?|results?|contacts?|accounts?|files?)|records?|results?|contacts?|accounts?|files?)\b/;
  const sourceClaimPattern = /\b(?:the file|the database|the crm|the records?|the results?)\s+(?:does not|did not|do not|were not|was not)\b/;
  const foundResultPattern = /\b(?:no matching|matching|exact match|exact matches|found no exact match|did not find)\b/;

  return evidenceVerbPattern.test(normalizedText)
    || noResultsPattern.test(normalizedText)
    || sourceClaimPattern.test(normalizedText)
    || foundResultPattern.test(normalizedText);
}

function getDefaultRejectedTextInstruction(params: {
  classification: Exclude<TurnLoopTextResponseClassification, 'verified_final_response'>;
  messages: LLMChatMessage[];
  observedInteractionProgress: boolean;
  observedActionEvidence: boolean;
}): string {
  const { classification, messages, observedInteractionProgress, observedActionEvidence } = params;
  const latestConversationMessage = [...messages].reverse().find((message) => message.role !== 'system');

  if (observedInteractionProgress && !observedActionEvidence) {
    if (latestConversationMessage?.role === 'user') {
      return DEFAULT_POST_INTERACTION_RECOVERY_INSTRUCTION;
    }

    return DEFAULT_WAITING_FOR_INTERACTION_RESOLUTION_INSTRUCTION;
  }

  if (classification === 'intent_only_narration') {
    return DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION;
  }

  if (classification === 'unsupported_evidence_claim') {
    return DEFAULT_UNSUPPORTED_EVIDENCE_CLAIM_RECOVERY_INSTRUCTION;
  }

  return DEFAULT_NON_PROGRESSING_TEXT_RECOVERY_INSTRUCTION;
}

function shouldPauseRejectedTextRetriesForPendingInteraction(params: {
  messages: LLMChatMessage[];
  observedInteractionProgress: boolean;
  observedActionEvidence: boolean;
}): boolean {
  const { messages, observedInteractionProgress, observedActionEvidence } = params;
  if (!observedInteractionProgress || observedActionEvidence) {
    return false;
  }

  const latestConversationMessage = [...messages].reverse().find((message) => message.role !== 'system');
  return latestConversationMessage?.role !== 'user';
}

function isActionEvidenceKind(evidenceKind: LLMToolEvidenceKind | undefined): boolean {
  return evidenceKind === 'read'
    || evidenceKind === 'write'
    || evidenceKind === 'external_action'
    || evidenceKind === 'artifact';
}

function createConfiguredToolDefinitionMap(
  request: TurnLoopPackageModelRequest | undefined,
): ReadonlyMap<string, LLMToolDefinition> {
  const definitions = new Map<string, LLMToolDefinition>();

  for (const tool of request?.extraTools ?? []) {
    definitions.set(tool.name, tool);
  }

  for (const [toolName, tool] of Object.entries(request?.tools ?? {})) {
    definitions.set(toolName, tool);
  }

  return definitions;
}

function classifyToolEvidence(
  toolName: string,
  toolDefinitions?: ReadonlyMap<string, LLMToolDefinition>,
): LLMToolEvidenceKind {
  const configuredKind = toolDefinitions?.get(toolName)?.evidenceKind;
  if (configuredKind) {
    return configuredKind;
  }

  if (INTERACTION_TOOL_NAME_SET.has(toolName)) {
    return 'interaction';
  }

  if (AGENT_CONTROL_TOOL_NAME_SET.has(toolName)) {
    return 'none';
  }

  if (READ_EVIDENCE_TOOL_NAME_SET.has(toolName)) {
    return 'read';
  }

  if (WRITE_EVIDENCE_TOOL_NAME_SET.has(toolName)) {
    return 'write';
  }

  if (EXTERNAL_ACTION_TOOL_NAME_SET.has(toolName)) {
    return 'external_action';
  }

  return 'external_action';
}

function summarizeToolEvidence(
  toolName: string,
  toolDefinitions?: ReadonlyMap<string, LLMToolDefinition>,
): { evidenceKind: LLMToolEvidenceKind; countsAsActionEvidence: boolean } {
  const evidenceKind = classifyToolEvidence(toolName, toolDefinitions);
  return {
    evidenceKind,
    countsAsActionEvidence: isActionEvidenceKind(evidenceKind),
  };
}

function countToolResultMessages(messages: LLMChatMessage[]): number {
  return messages.filter((message) => message.role === 'tool').length;
}

export function createAgentControlToolDefinitions(): LLMToolDefinition[] {
  return [
    {
      name: 'final_answer',
      description: 'End the agent run with the final answer. Use this only when the answer is complete and supported by run evidence.',
      evidenceKind: 'none',
      parameters: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            description: 'Required final answer to return to the user.',
          },
          evidenceRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional references to tool results, files, or other run evidence supporting the final answer.',
          },
        },
        required: ['answer'],
        additionalProperties: false,
      },
    },
    {
      name: 'need_user_input',
      description: 'Stop the agent run because required user input is missing.',
      evidenceKind: 'none',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'Required user-facing question asking for the missing input.',
          },
          reason: {
            type: 'string',
            description: 'Required reason why the run cannot continue without the user input.',
          },
        },
        required: ['question', 'reason'],
        additionalProperties: false,
      },
    },
    {
      name: 'blocked',
      description: 'Stop the agent run because a permission, safety, or external block prevents further progress.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Required explanation of the block preventing progress.',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  ];
}

function assertNoAgentControlToolNameCollisions(
  extraTools: LLMToolDefinition[] = [],
  tools?: Record<string, LLMToolDefinition>,
): void {
  for (const tool of extraTools) {
    if (AGENT_CONTROL_TOOL_NAME_SET.has(String(tool.name || '').trim())) {
      throw new Error(`Tool name "${tool.name}" is reserved by llm-runtime agent control tools.`);
    }
  }

  for (const toolName of Object.keys(tools ?? {})) {
    if (AGENT_CONTROL_TOOL_NAME_SET.has(String(toolName || '').trim())) {
      throw new Error(`Tool name "${toolName}" is reserved by llm-runtime agent control tools.`);
    }
  }
}

function formatCompletionLoopContractBlock(): string {
  return [
    `<${COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG}>`,
    DEFAULT_AGENT_RUN_LOOP_SYSTEM_PROMPT,
    `</${COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG}>`,
  ].join('\n');
}

function mergeCompletionLoopSystemPrompt<TMessage extends LLMChatMessage>(messages: TMessage[]): TMessage[] {
  const contractBlock = formatCompletionLoopContractBlock();
  const systemMessageIndex = messages.findIndex((message) => message.role === 'system');

  if (systemMessageIndex >= 0) {
    const systemMessage = messages[systemMessageIndex];
    const existingContent = String(systemMessage?.content ?? '');
    if (
      existingContent.includes(`<${COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG}>`)
      || existingContent === DEFAULT_AGENT_RUN_LOOP_SYSTEM_PROMPT
    ) {
      return messages;
    }

    const nextMessages = messages.slice();
    nextMessages[systemMessageIndex] = {
      ...systemMessage,
      content: existingContent.trim()
        ? `${existingContent}\n\n${contractBlock}`
        : contractBlock,
    };
    return nextMessages;
  }

  return [
    { role: 'system', content: contractBlock } as TMessage,
    ...messages,
  ];
}

function parseToolArgumentsObject(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function tryParseControlToolOutput(toolCall: LLMToolCall): TurnLoopControlOutput | null {
  if (!AGENT_CONTROL_TOOL_NAME_SET.has(toolCall.function.name)) {
    return null;
  }

  const args = parseToolArgumentsObject(toolCall.function.arguments);

  if (toolCall.function.name === 'final_answer') {
    if (!isNonEmptyString(args.answer)) {
      return null;
    }

    return {
      kind: 'final_answer',
      toolCallId: toolCall.id,
      answer: args.answer,
      evidenceRefs: toStringArray(args.evidenceRefs),
    };
  }

  if (toolCall.function.name === 'need_user_input') {
    if (!isNonEmptyString(args.question) || !isNonEmptyString(args.reason)) {
      return null;
    }

    return {
      kind: 'need_user_input',
      toolCallId: toolCall.id,
      question: args.question,
      reason: args.reason,
    };
  }

  if (!isNonEmptyString(args.reason)) {
    return null;
  }

  return {
    kind: 'blocked',
    toolCallId: toolCall.id,
    reason: args.reason,
  };
}

function withAgentControlTools(request: TurnLoopPackageModelRequest): TurnLoopPackageModelRequest {
  assertNoAgentControlToolNameCollisions(request.extraTools ?? [], request.tools);

  return {
    ...request,
    extraTools: [
      ...(request.extraTools ?? []),
      ...createAgentControlToolDefinitions(),
    ],
  };
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
  options: RunCompletionLoopOptions<TState, TMessage>,
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

  throw new Error('runCompletionLoop requires either callModel or modelRequest.');
}

function createCompletionToolExecutor(
  request: TurnLoopPackageModelRequest | undefined,
  observeToolEvidence: (toolCalls: LLMToolCall[]) => void,
): TurnLoopToolExecutor | undefined {
  if (!request) {
    return undefined;
  }

  const configuredToolDefinitions = createConfiguredToolDefinitionMap(request);

  const recordToolEvidence = (toolCalls: LLMToolCall[]) => {
    const observedToolCalls = toolCalls.filter((toolCall) => {
      const evidenceKind = classifyToolEvidence(toolCall.function.name, configuredToolDefinitions);
      return evidenceKind === 'interaction' || isActionEvidenceKind(evidenceKind);
    });

    if (observedToolCalls.length > 0) {
      observeToolEvidence(observedToolCalls);
    }
  };

  const resolveOptions: Omit<LLMExecuteToolCallOptions, 'toolCall' | 'context' | 'errorMode'> = {
    environment: request.environment,
    mcpConfig: request.mcpConfig,
    skillRoots: request.skillRoots,
    builtIns: request.builtIns,
    includeDeprecatedBuiltInAliases: request.includeDeprecatedBuiltInAliases,
    extraTools: request.extraTools,
    tools: request.tools,
  };

  return {
    executeToolCall: async (toolCall, context, options = {}) => {
      const result = await executeToolCall({
        ...resolveOptions,
        ...options,
        toolCall,
        context,
      });
      recordToolEvidence([toolCall]);
      return result;
    },
    executeToolCalls: async (toolCalls, context, options = {}) => {
      const result = await executeToolCalls({
        ...resolveOptions,
        ...options,
        toolCalls,
        context,
      });
      recordToolEvidence(toolCalls);
      return result;
    },
  };
}

export async function runCompletionLoop<TState, TMessage extends LLMChatMessage = LLMChatMessage>(
  options: RunCompletionLoopOptions<TState, TMessage>,
): Promise<RunCompletionLoopResult<TState>> {
  const callModel = resolveModelCaller(options);
  const defaultTextResponseMode = options.defaultTextResponseMode ?? 'permissive';
  const agentControlMode = options.agentControlMode ?? false;
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
  let observedInteractionProgress = false;
  let observedActionEvidence = false;
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
    controlOutput?: TurnLoopControlOutput | null;
  }): Promise<RunCompletionLoopResult<TState>> {
    const result: RunCompletionLoopResult<TState> = {
      state,
      iterations,
      emptyTextRetryCount,
      rejectedTextRetryCount,
      controlOutput: params.controlOutput ?? null,
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
        ...summarizeToolEvidence(toolCall.function.name),
        toolArguments: toolCall.function.arguments,
        normalizedArguments: normalizeToolArguments(toolCall.function.arguments),
        toolIndex,
        source: toolCallSource,
        synthetic: Boolean(toolCall.synthetic),
      }));
      if (batchToolCalls.some((toolCall) => toolCall.evidenceKind === 'interaction')) {
        observedInteractionProgress = true;
      }
      if (batchToolCalls.some((toolCall) => toolCall.countsAsActionEvidence)) {
        observedActionEvidence = true;
      }
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

      const stopForRepeatedToolCall = async () => {
        if (!repeatedToolCallStopped) {
          return null;
        }

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
      };

      const stopForMaxToolRounds = async () => {
        if (consecutiveToolTurns <= maxConsecutiveToolTurns) {
          return null;
        }

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
      };

      const stopForToolGuards = async () => {
        const repeatedStop = await stopForRepeatedToolCall();
        if (repeatedStop) {
          return repeatedStop;
        }

        return await stopForMaxToolRounds();
      };

      if (agentControlMode) {
        const controlToolCalls = (response.tool_calls ?? []).filter((toolCall) => AGENT_CONTROL_TOOL_NAME_SET.has(toolCall.function.name));
        if (controlToolCalls.length > 0) {
          if (controlToolCalls.length !== 1 || (response.tool_calls?.length ?? 0) !== 1) {
            const guardStop = await stopForToolGuards();
            if (guardStop) {
              return guardStop;
            }
            recordStep(iteration, response, 'tool_calls_continue');
            transientInstruction = DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION;
            continue;
          }

          const controlOutput = tryParseControlToolOutput(controlToolCalls[0]);
          if (!controlOutput) {
            const guardStop = await stopForToolGuards();
            if (guardStop) {
              return guardStop;
            }
            recordStep(iteration, response, 'tool_calls_continue');
            transientInstruction = DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION;
            continue;
          }

          if (controlOutput?.kind === 'final_answer') {
            const next = await options.onFinalAnswerToolCall?.({
              state,
              controlOutput,
              response,
              messages,
              iteration,
            });
            state = next?.state ?? state;
            if (next?.next?.control === 'continue') {
              const guardStop = await stopForToolGuards();
              if (guardStop) {
                return guardStop;
              }
              recordStep(iteration, response, 'tool_calls_continue');
              transientInstruction = next.next.transientInstruction ?? DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION;
              continue;
            }

            recordStep(iteration, response, 'final_answer_stop');
            return await finalize({
              reason: 'final_answer',
              response,
              controlOutput,
              stop: {
                reason: 'final_answer',
                iteration,
                elapsedMs: getElapsedMs(),
                maxIterations,
                maxConsecutiveToolTurns,
                maxWallTimeMs,
                controlOutput,
              },
            });
          }

          if (controlOutput?.kind === 'need_user_input') {
            const next = await options.onNeedUserInputToolCall?.({
              state,
              controlOutput,
              response,
              messages,
              iteration,
            });
            state = next?.state ?? state;
            if (next?.next?.control === 'continue') {
              const guardStop = await stopForToolGuards();
              if (guardStop) {
                return guardStop;
              }
              recordStep(iteration, response, 'tool_calls_continue');
              transientInstruction = next.next.transientInstruction ?? DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION;
              continue;
            }

            recordStep(iteration, response, 'needs_user_input_stop');
            return await finalize({
              reason: 'needs_user_input',
              response,
              controlOutput,
              stop: {
                reason: 'needs_user_input',
                iteration,
                elapsedMs: getElapsedMs(),
                maxIterations,
                maxConsecutiveToolTurns,
                maxWallTimeMs,
                controlOutput,
              },
            });
          }

          if (controlOutput?.kind === 'blocked') {
            const next = await options.onBlockedToolCall?.({
              state,
              controlOutput,
              response,
              messages,
              iteration,
            });
            state = next?.state ?? state;
            if (next?.next?.control === 'continue') {
              const guardStop = await stopForToolGuards();
              if (guardStop) {
                return guardStop;
              }
              recordStep(iteration, response, 'tool_calls_continue');
              transientInstruction = next.next.transientInstruction ?? DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION;
              continue;
            }

            recordStep(iteration, response, 'blocked_stop');
            return await finalize({
              reason: 'blocked',
              response,
              controlOutput,
              stop: {
                reason: 'blocked',
                iteration,
                elapsedMs: getElapsedMs(),
                maxIterations,
                maxConsecutiveToolTurns,
                maxWallTimeMs,
                controlOutput,
              },
            });
          }
        }
      }

      const guardStop = await stopForToolGuards();
      if (guardStop) {
        return guardStop;
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
      const packageRequiresActionEvidence = defaultTextResponseMode === 'require_tool_result'
        && countToolResultMessages(messages) === 0;
      const requiresActionEvidence = await options.requiresActionEvidence?.({
        state,
        responseText,
        response,
        messages,
        iteration,
      }) ?? packageRequiresActionEvidence;
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
          classification: requiresActionEvidence || agentControlMode
            ? (requiresActionEvidence && !observedActionEvidence && isUnsupportedEvidenceClaim(responseText)
              ? 'unsupported_evidence_claim'
              : 'non_progressing')
            : 'verified_final_response',
          transientInstruction: agentControlMode
            ? DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION
            : undefined,
        } satisfies TurnLoopTextResponseAssessment;

      classifications.push({
        iteration,
        classification: assessment.classification,
        requiresActionEvidence,
        observedInteractionProgress,
        observedActionEvidence,
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
      const rejectedTextRetryLimit = shouldPauseRejectedTextRetriesForPendingInteraction({
        messages,
        observedInteractionProgress,
        observedActionEvidence,
      })
        ? 0
        : (options.rejectedTextRetryLimit ?? (requiresActionEvidence ? 2 : 0));

      if (rejectedTextRetryCount < rejectedTextRetryLimit && next?.next?.control !== 'stop') {
        const retryCountBefore = rejectedTextRetryCount;
        rejectedTextRetryCount += 1;
        transientInstruction = next?.next?.control === 'continue'
          ? (next.next.transientInstruction
            ?? assessment.transientInstruction
            ?? getDefaultRejectedTextInstruction({
              classification: assessment.classification,
              messages,
              observedInteractionProgress,
              observedActionEvidence,
            }))
          : (assessment.transientInstruction ?? getDefaultRejectedTextInstruction({
            classification: assessment.classification,
            messages,
            observedInteractionProgress,
            observedActionEvidence,
          }));
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
        transientInstruction: assessment.transientInstruction ?? getDefaultRejectedTextInstruction({
          classification: assessment.classification,
          messages,
          observedInteractionProgress,
          observedActionEvidence,
        }),
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

export async function complete<TState, TMessage extends LLMChatMessage = LLMChatMessage>(
  options: CompleteOptions<TState, TMessage>,
): Promise<RunCompletionLoopResult<TState>> {
  const callerBuildMessages = options.buildMessages;
  const callerClassifyTextResponse = options.classifyTextResponse;
  const callerRequiresActionEvidence = options.requiresActionEvidence;
  const callerOnToolCallsResponse = options.onToolCallsResponse;
  const agentControlMode = options.agentControlMode ?? Boolean(options.modelRequest);
  const defaultTextResponseMode = options.defaultTextResponseMode ?? 'require_tool_result';
  const modelRequest = options.modelRequest && agentControlMode
    ? withAgentControlTools(options.modelRequest)
    : options.modelRequest;
  const configuredToolDefinitions = createConfiguredToolDefinitionMap(modelRequest);
  const classificationObservations = new Map<number, {
    observedInteractionProgress: boolean;
    observedActionEvidence: boolean;
  }>();
  let observedInteractionProgress = false;
  let observedActionEvidence = false;
  const observeToolEvidence = (toolCalls: LLMToolCall[]) => {
    for (const toolCall of toolCalls) {
      const evidenceKind = classifyToolEvidence(toolCall.function.name, configuredToolDefinitions);
      if (evidenceKind === 'interaction') {
        observedInteractionProgress = true;
      }
      if (isActionEvidenceKind(evidenceKind)) {
        observedActionEvidence = true;
      }
    }
  };
  const toolExecutor = createCompletionToolExecutor(modelRequest, observeToolEvidence);

  const result = await runCompletionLoop({
    ...options,
    emptyTextRetryLimit: options.emptyTextRetryLimit ?? 0,
    modelRequest,
    agentControlMode,
    buildMessages: async (params) => {
      const messages = mergeCompletionLoopSystemPrompt(await callerBuildMessages(params));
      return messages;
    },
    onToolCallsResponse: async (params) => {
      const next = await callerOnToolCallsResponse({
        ...params,
        toolExecutor,
      });
      if (next?.next?.control === 'continue') {
        observeToolEvidence(params.response.tool_calls ?? []);
      }
      return next;
    },
    classifyTextResponse: async (params) => {
      classificationObservations.set(params.iteration, {
        observedInteractionProgress,
        observedActionEvidence,
      });
      return await callerClassifyTextResponse?.(params);
    },
    requiresActionEvidence: async (params) => {
      const packageRequiresActionEvidence = defaultTextResponseMode === 'require_tool_result'
        && !observedActionEvidence;
      return await callerRequiresActionEvidence?.(params) ?? packageRequiresActionEvidence;
    },
    defaultTextResponseMode,
    rejectedTextRetryLimit: options.rejectedTextRetryLimit ?? 2,
  });

  for (const toolCallSummary of result.toolCalls) {
    const evidence = summarizeToolEvidence(toolCallSummary.toolName, configuredToolDefinitions);
    toolCallSummary.evidenceKind = evidence.evidenceKind;
    toolCallSummary.countsAsActionEvidence = evidence.countsAsActionEvidence;
  }

  for (const classificationSummary of result.classifications) {
    const observation = classificationObservations.get(classificationSummary.iteration);
    if (observation) {
      classificationSummary.observedInteractionProgress = observation.observedInteractionProgress;
      classificationSummary.observedActionEvidence = observation.observedActionEvidence;
    }
  }

  return result;
}

/** @deprecated Use RunCompletionLoopOptions */
export type RunTurnLoopOptions<TState, TMessage extends LLMChatMessage = LLMChatMessage> =
  RunCompletionLoopOptions<TState, TMessage>;

/** @deprecated Use RunCompletionLoopResult */
export type RunTurnLoopResult<TState> = RunCompletionLoopResult<TState>;

/** @deprecated Use runCompletionLoop */
export const runTurnLoop = runCompletionLoop;

/** @deprecated Use complete */
export const respondWithTools = complete;
