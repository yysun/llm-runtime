/**
 * LLM Package Public Entrypoint
 *
 * Purpose:
 * - Export the minimal public API for the publishable `llm-runtime` workspace.
 *
 * Key features:
 * - One-shot `generate(...)` for a single model call.
 * - Agentic `complete(...)` and `streamComplete(...)` that own the tool-loop and terminate on control tools.
 * - Optional `createRuntime(...)` for callers that want to reuse providers/MCP/skills across many calls.
 * - Compact type set covering messages, tool definitions, results, and provider configuration.
 *
 * Implementation notes:
 * - Internal turn-loop machinery, recovery instructions, validation helpers, and direct provider clients
 *   are intentionally not re-exported here. Import them from internal paths only when extending the package.
 *
 * Recent changes:
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
  RuntimeCompleteResult,
  RuntimeCompleteStatus,
  RuntimeStreamCompleteEvent,
} from './runtime-complete-contract.js';
