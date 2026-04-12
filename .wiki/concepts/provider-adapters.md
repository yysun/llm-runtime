---
title: "Provider Adapters"
type: "concept"
status: "active"
source_paths:
  - "src/openai-direct.ts"
  - "src/anthropic-direct.ts"
  - "src/google-direct.ts"
  - "src/provider-utils.ts"
updated_at: "2026-04-12"
---

The provider modules are pure request/response adapters. They convert package-native messages and tools into provider-specific payloads, then convert provider replies back into `LLMResponse`.

Differences by adapter:
- `src/openai-direct.ts` covers OpenAI, Azure, XAI, Ollama, and generic OpenAI-compatible endpoints. It also normalizes tool-call ids to fit OpenAI's 40-character limit.
- `src/anthropic-direct.ts` extracts the system prompt into Anthropic's `system` field and replays tool history through `tool_use` and `tool_result` blocks.
- `src/google-direct.ts` converts tool schemas into Gemini declarations, strips unsupported `additionalProperties`, and flattens historical tool activity into text-compatible replay.

Shared boundary:
- No adapter executes tools.
- No adapter owns persistence or turn-loop policy.
- Shared helpers in `src/provider-utils.ts` intentionally keep logging quiet and id generation package-local.

Read this with [[src-runtime]] when a provider-specific bug appears during message conversion, tool-call replay, or streamed output handling.