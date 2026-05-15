---
title: "Public Types"
type: "entity"
status: "active"
language: "default"
source_paths:
  - "src/types.ts"
  - "src/index.ts"
  - "src/completion-loop.ts"
  - "src/turn-loop.ts"
  - "src/runtime.ts"
updated_at: "2026-05-15"
---

`src/types.ts` defines the package-native contracts exported from the root entrypoint.

Key entities:
- `LLMChatMessage`, `LLMToolCall`, `LLMResponse`, and `LLMStreamChunk` form the provider-independent conversation model.
- `LLMToolDefinition`, `LLMToolRegistry`, and `LLMToolExecutionContext` define callable tool surfaces and runtime context.
- `LLMEnvironment`, `LLMEnvironmentOptions`, `MCPRegistry`, and `SkillRegistry` define the stable runtime dependencies described in [[environment-vs-per-call]]. `LLMRuntime` adds the preferred bound facade methods `generate(...)`, `stream(...)`, `complete(...)`, `resolveTools(...)`, and `dispose()`. Provider config types include first-class Azure support through `AzureConfig`, and MCP server definitions include `streamable-http` alongside `stdio` and `sse`.
- `LLMWebSearchOptions` plus `webSearch?: boolean | LLMWebSearchOptions` on `LLMGenerateOptions` and `LLMStreamOptions` define the public per-call search surface described in [[web-search-across-providers]].
- `ToolValidationIssue` and `ToolValidationFailureArtifact` are part of the public correction and recovery path described in [[src-tool-validation]].
- `BuiltInToolName` includes the filesystem trio `search_files`, `create_directory`, and `path_exists`, and also preserves the deprecated HITL alias `ask_user_question` alongside `ask_user_input` and `human_intervention_request`.
- Human-input public types now model structured choice prompts through `HitlSelectionType`, `HitlInputQuestion`, and `HitlInputOption`.

Recent type surface changes:
- `LLMToolCall.synthetic?: boolean` lets callers distinguish normalized plain-text tool intents from model-emitted tool calls when `runTurnLoop(...)` synthetic marking is enabled.
- `TurnLoopDefaultTextResponseMode` adds the public `'permissive' | 'require_tool_result'` switch for turn-loop text handling.
- `RunCompletionLoopOptions` and `RunCompletionLoopResult` are now the preferred completion-loop types. `RunTurnLoopOptions` and `RunTurnLoopResult` remain as deprecated compatibility aliases.
- `TurnLoopTerminalReason` now covers deterministic control-tool stops (`final_answer`, `needs_user_input`, `blocked`) in addition to hard-stop reasons such as timeout and repeated identical tool-call suppression.
- The root entrypoint now exports `createRuntime(...)`, `disposeRuntimeCaches()`, `complete(...)`, and `runCompletionLoop(...)` as the preferred public API names, while keeping the older runtime and turn-loop names as deprecated aliases.
- The root entrypoint also re-exports the completion-loop trace and lifecycle types, so callers can type metrics, stop metadata, and wrapper defaults without reaching into internal modules.

Design intent:
- Provider names are plain string unions rather than app-local enums.
- World, chat, and agent metadata appear only as optional execution-context fields, which keeps the main API portable outside the original application.

Use this page as the map of exported contracts before drilling into implementation pages such as [[src-runtime]], [[src-completion-loop]], or [[src-turn-loop]].
