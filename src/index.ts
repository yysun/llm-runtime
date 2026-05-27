/**
 * LLM Package Public Entrypoint
 *
 * Purpose:
 * - Export the public API for the publishable `llm-runtime` workspace.
 *
 * Key features:
 * - Per-call `generate(...)`, plus explicit runtime-facade agentic helpers.
 * - Package-owned provider configuration helpers.
 * - Package-owned built-in tool catalog and runtime helpers.
 * - Generic host-agnostic turn-loop orchestration helpers.
 * - MCP, skill, and tool registry helpers and types.
 *
 * Implementation notes:
 * - Keeps the package surface explicit and typed.
 * - Avoids package-to-core imports so the workspace stays publishable.
 * - Serves as the primary import target for `core` and external consumers.
 *
 * Recent changes:
 * - 2026-05-27: Hid `runCompletionLoop` and `RunCompletionLoopOptions` from the public surface; `complete(...)` is the only supported loop entrypoint.
 * - 2026-05-15: The runtime facade now exposes hardened `complete(...)` and `streamComplete(...)` helpers backed by the package completion loop.
 * - 2026-05-15: Exported package-owned `executeToolCall(...)` and `executeToolCalls(...)` helpers.
 * - 2026-05-15: Promoted `createRuntime(...)`, `complete(...)`, and `runCompletionLoop(...)` as the preferred public API names.
 * - 2026-03-29: Exported the generic host-agnostic completion-loop package API.
 * - 2026-03-27: Initial public API for `packages/llm`.
 */

export * from './types.js';
export * from './builtins.js';
export * from './human-input-contract.js';
export * from './llm-config.js';
export * from './mcp.js';
export * from './skills.js';
export * from './tools.js';
export * from './tool-validation.js';
export {
  AGENT_CONTROL_TOOL_NAMES,
  COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG,
  DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION,
  DEFAULT_COMPLETION_LOOP_SYSTEM_PROMPT,
  DEFAULT_EMPTY_TEXT_RECOVERY_INSTRUCTION,
  DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION,
  DEFAULT_NON_PROGRESSING_TEXT_RECOVERY_INSTRUCTION,
  DEFAULT_POST_INTERACTION_RECOVERY_INSTRUCTION,
  DEFAULT_REPEATED_TOOL_CALL_RECOVERY_INSTRUCTION,
  DEFAULT_TIMEOUT_AFTER_TOOL_RESULT_MESSAGE,
  DEFAULT_TURN_LOOP_MAX_CONSECUTIVE_SAME_TOOL_CALL_BATCHES,
  DEFAULT_TURN_LOOP_MAX_CONSECUTIVE_TOOL_TURNS,
  DEFAULT_TURN_LOOP_MAX_ITERATIONS,
  DEFAULT_TURN_LOOP_MAX_WALL_TIME_MS,
  DEFAULT_UNSUPPORTED_EVIDENCE_CLAIM_RECOVERY_INSTRUCTION,
  DEFAULT_WAITING_FOR_INTERACTION_RESOLUTION_INSTRUCTION,
  complete,
  createAgentControlToolDefinitions,
} from './completion-loop.js';
export type {
  AgentControlToolName,
  CompleteOptions,
  RunCompletionLoopResult,
  TurnLoopBlockedControlOutput,
  TurnLoopBoundToolExecutorOptions,
  TurnLoopClassificationEvent,
  TurnLoopClassificationSummary,
  TurnLoopControl,
  TurnLoopControlOutput,
  TurnLoopControlToolCallEvent,
  TurnLoopDefaultTextResponseMode,
  TurnLoopFinalAnswerControlOutput,
  TurnLoopIterationStartEvent,
  TurnLoopModelResponseEvent,
  TurnLoopNeedUserInputControlOutput,
  TurnLoopPackageModelRequest,
  TurnLoopRepeatedToolCallGuard,
  TurnLoopRepeatedToolCallStopDetail,
  TurnLoopRetryKind,
  TurnLoopRetrySummary,
  TurnLoopStepBranch,
  TurnLoopStepResult,
  TurnLoopStepSummary,
  TurnLoopStopEvent,
  TurnLoopStopMetadata,
  TurnLoopTerminalReason,
  TurnLoopTextResponseAssessment,
  TurnLoopTextResponseClassification,
  TurnLoopToolCallSource,
  TurnLoopToolCallSummary,
  TurnLoopToolExecutor,
} from './completion-loop.js';
export * from './runtime-complete-contract.js';
export {
  DEFAULT_HUMAN_INTERVENTION_TOOL_HINT,
  DEFAULT_WORKSPACE_TOOL_HINT,
  createRuntime,
  disposeRuntimeCaches,
  executeToolCall,
  executeToolCalls,
  generate,
  resolveTools,
  resolveToolsAsync,
} from './runtime.js';
export * from './openai-direct.js';
export * from './anthropic-direct.js';
export * from './google-direct.js';
