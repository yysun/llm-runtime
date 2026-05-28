---
title: "Public Types"
type: "entity"
status: "active"
language: "default"
source_paths:
  - "src/types.ts"
  - "src/index.ts"
  - "src/runtime-complete-contract.ts"
  - "src/runtime.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-27"
---

`src/types.ts` defines the package-native contracts that support the narrowed root entrypoint.

Key entities:
- `LLMChatMessage`, `LLMToolCall`, `LLMResponse`, and `LLMStreamChunk` form the provider-independent conversation model. `LLMStreamChunk` can carry provider text, reasoning text, warnings, and streamed tool-call argument deltas.
- `LLMToolDefinition`, `LLMToolRegistry`, and `LLMToolExecutionContext` define callable tool surfaces and runtime context.
- `LLMEnvironment`, `LLMEnvironmentOptions`, `MCPRegistry`, and `SkillRegistry` define the stable runtime dependencies described in [[environment-vs-per-call]]. `LLMRuntime` adds the preferred bound facade methods `generate(...)`, `complete(...)`, `streamComplete(...)`, `resolveTools(...)`, `executeToolCall(...)`, `executeToolCalls(...)`, and `dispose()`. Provider config types include first-class Azure support through `AzureConfig`, and MCP server definitions include `streamable-http` alongside `stdio` and `sse`.
- `LLMWebSearchOptions` plus `webSearch?: boolean | LLMWebSearchOptions` on provider-call options define the public per-call search surface described in [[web-search-across-providers]].
- `BuiltInToolName` includes the filesystem trio `search_files`, `create_directory`, and `path_exists`. `BuiltInToolSelection` supports boolean selection plus a per-tool map: omitted or `true` means every built-in, `false` means none, and a map narrows to selected tools.
- Human-input public types now model structured choice prompts through `HitlSelectionType`, `HitlInputQuestion`, and `HitlInputOption`.
- Runtime-facade completion types live in `src/runtime-complete-contract.ts`: `RuntimeCompleteResult`, `RuntimeCompleteStatus`, and `RuntimeStreamCompleteEvent`.

Recent type surface changes:
- `RuntimeCompleteStatus` now uses `tool_calls` as the generic host-handled branch instead of a HITL-specific `waiting_for_human` state.
- `RuntimeStreamCompleteEvent` includes `tool_calls`, `text_delta`, `reasoning_delta`, `tool_call_delta`, and `final_answer_delta` events, so streaming callers can separate lifecycle updates from provider-visible deltas and display control-tool final answers before the completed tool call is assembled.
- `LLMResponse` now carries additive stop metadata through `stopKind` and `providerStopReason`, which lets callers preserve the provider's native stop reason without giving up a normalized package-level stop kind.
- `LLMRuntimeCompleteOptions` includes completion-loop guardrails such as `defaultTextResponseMode`, `rejectedTextRetryLimit`, `emptyTextRetryLimit`, `maxIterations`, and `repeatedToolCallGuard`, which the runtime facade forwards into the hardened loop. Outer wall-clock budgets and tool-turn budgets are host policy and should be enforced through host cancellation with `context.abortSignal`.
- The root entrypoint now exports only `generate(...)`, `complete(...)`, `streamComplete(...)`, `createRuntime(...)`, and the minimum type set needed to call them. Lower-level completion-loop, validation, recovery, direct provider, cache cleanup, and tool-resolution helpers are intentionally not root exports.

Design intent:
- Provider names are plain string unions rather than app-local enums.
- World, chat, and agent metadata appear only as optional execution-context fields, which keeps the main API portable outside the original application.

Use this page as the map of root-supported contracts before drilling into implementation pages such as [[src-runtime]], [[src-completion-loop]], or [[src-turn-loop]].
