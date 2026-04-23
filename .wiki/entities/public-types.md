---
title: "Public Types"
type: "entity"
status: "active"
source_paths:
  - "src/types.ts"
  - "src/index.ts"
  - "src/turn-loop.ts"
  - "src/runtime.ts"
updated_at: "2026-04-23"
---

`src/types.ts` defines the package-native contracts exported from the root entrypoint.

Key entities:
- `LLMChatMessage`, `LLMToolCall`, `LLMResponse`, and `LLMStreamChunk` form the provider-independent conversation model.
- `LLMToolDefinition`, `LLMToolRegistry`, and `LLMToolExecutionContext` define callable tool surfaces and runtime context.
- `LLMEnvironment`, `LLMEnvironmentOptions`, `MCPRegistry`, and `SkillRegistry` define the stable runtime dependencies described in [[environment-vs-per-call]]. Provider config types now include first-class Azure support through `AzureConfig`, and MCP server definitions include `streamable-http` alongside `stdio` and `sse`.
- `LLMWebSearchOptions` plus `webSearch?: boolean | LLMWebSearchOptions` on `LLMGenerateOptions` and `LLMStreamOptions` define the public per-call search surface described in [[web-search-across-providers]].
- `ToolValidationIssue` and `ToolValidationFailureArtifact` are part of the public correction and recovery path described in [[src-tool-validation]].

Recent type surface changes:
- `LLMToolCall.synthetic?: boolean` lets callers distinguish normalized plain-text tool intents from model-emitted tool calls when `runTurnLoop(...)` synthetic marking is enabled.
- The root entrypoint also re-exports the turn-loop trace and lifecycle types defined in `src/turn-loop.ts`, so callers can type metrics and stop metadata without reaching into internal modules.

Design intent:
- Provider names are plain string unions rather than app-local enums.
- World, chat, and agent metadata appear only as optional execution-context fields, which keeps the main API portable outside the original application.

Use this page as the map of exported contracts before drilling into implementation pages such as [[src-runtime]] or [[src-turn-loop]].
