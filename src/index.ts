/**
 * LLM Package Public Entrypoint
 *
 * Purpose:
 * - Export the minimal public API for the publishable `llm-runtime` workspace.
 *
 * Key features:
 * - One-shot `generate(...)` for a single model call.
 * - Agentic `complete(...)` and `streamComplete(...)` that own the tool-loop and prefer control-tool termination while accepting evidence-backed plain completion.
 * - Optional `createRuntime(...)` for callers that want to reuse providers/MCP/skills across many calls.
 * - Compact type set covering messages, tool definitions, results, and provider configuration.
 *
 * Implementation notes:
 * - Internal turn-loop machinery, recovery instructions, validation helpers, and direct provider clients
 *   are intentionally not re-exported here. Import them from internal paths only when extending the package.
 *
 * Recent changes:
 * - 2026-07-28: Exported fail-closed human-input and tool-approval cancellation contracts.
 * - 2026-05-29: Documented the Copilot-style completion contract for the public runtime facade.
 * - 2026-05-27: Reduced the public surface to `complete`, `streamComplete`, `generate`, `createRuntime`,
 *   and the minimum type set needed to use them. Internal helpers, turn-loop hooks, recovery prompts,
 *   and direct provider clients are no longer re-exported.
 */

export {
  complete,
  createRuntime,
  generate,
  streamComplete,
} from './runtime.js';

export {
  createAskUserInputResult,
  createHumanInputToolResult,
  normalizeAskUserInputOutcome,
} from './runtime-complete-contract.js';

export type {
  BuiltInToolName,
  BuiltInToolSelection,
  LLMChatMessage,
  LLMEnvironment,
  LLMEnvironmentOptions,
  LLMProviderConfigs,
  LLMProviderName,
  LLMResponse,
  LLMRuntime,
  LLMRuntimeCompleteOptions,
  LLMRuntimeCompleteResult,
  LLMRuntimeStreamCompleteEvent,
  LLMRuntimeStreamCompleteOptions,
  LLMRuntimeToolApprovalRequest,
  LLMRuntimeToolApprovalCancelReason,
  LLMRuntimeToolApprovalResponse,
  LLMRuntimeToolHandlerRequest,
  LLMRuntimeToolHandlerResponse,
  LLMStreamChunk,
  LLMToolCall,
  LLMToolDefinition,
  LLMToolEvidenceKind,
  LLMToolExecutionContext,
  LLMUsage,
  MCPConfig,
  ProviderConfig,
  ReasoningEffort,
  ToolPermission,
} from './types.js';

export type {
  AskUserInputAnsweredOutcome,
  AskUserInputCancellationReason,
  AskUserInputCancelledOutcome,
  AskUserInputOutcome,
  AskUserInputRawResponse,
  PendingHumanInput,
  RuntimeCancellation,
  RuntimeCompleteResult,
  RuntimeCompleteStatus,
  RuntimeStreamCompleteEvent,
  RuntimeToolApprovalCancellation,
  RuntimeToolApprovalCancellationReason,
} from './runtime-complete-contract.js';
