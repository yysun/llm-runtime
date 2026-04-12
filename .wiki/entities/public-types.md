---
title: "Public Types"
type: "entity"
status: "active"
source_paths:
  - "src/types.ts"
  - "src/index.ts"
updated_at: "2026-04-12"
---

`src/types.ts` defines the package-native contracts exported from the root entrypoint.

Key entities:
- `LLMChatMessage`, `LLMToolCall`, `LLMResponse`, and `LLMStreamChunk` form the provider-independent conversation model.
- `LLMToolDefinition`, `LLMToolRegistry`, and `LLMToolExecutionContext` define callable tool surfaces and runtime context.
- `LLMEnvironment`, `LLMEnvironmentOptions`, `MCPRegistry`, and `SkillRegistry` define the stable runtime dependencies described in [[environment-vs-per-call]].
- `ToolValidationIssue` and `ToolValidationFailureArtifact` are part of the public correction and recovery path described in [[src-tool-validation]].

Design intent:
- Provider names are plain string unions rather than app-local enums.
- World, chat, and agent metadata appear only as optional execution-context fields, which keeps the main API portable outside the original application.

Use this page as the map of exported contracts before drilling into implementation pages such as [[src-runtime]] or [[src-turn-loop]].