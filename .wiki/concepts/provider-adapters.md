---
title: "Provider Adapters"
type: "concept"
status: "active"
source_paths:
  - "README.md"
  - "src/openai-direct.ts"
  - "src/anthropic-direct.ts"
  - "src/google-direct.ts"
  - "src/provider-utils.ts"
  - "tests/llm/openai-direct.test.ts"
  - "tests/llm/anthropic-direct.test.ts"
  - "tests/llm/google-direct.test.ts"
updated_at: "2026-04-23"
---

The provider modules are pure request/response adapters. They convert package-native messages and tools into provider-specific payloads, then convert provider replies back into `LLMResponse`.

Differences by adapter:
- `src/openai-direct.ts` covers OpenAI, Azure OpenAI, XAI, Ollama, and generic OpenAI-compatible endpoints through one chat-completions adapter. It now forwards `reasoningEffort` as `reasoning_effort`, forwards per-call `webSearch` as `web_search_options`, and normalizes historical tool-call ids to fit OpenAI's 40-character limit.
- `src/anthropic-direct.ts` extracts the system prompt into Anthropic's `system` field, replays tool history through `tool_use` and `tool_result` blocks, and adds Anthropic's built-in `web_search_20250305` server tool when `webSearch` is enabled. Server-side web-search blocks are intentionally kept provider-local and do not surface as host `tool_calls`.
- `src/google-direct.ts` converts tool schemas into Gemini declarations, dereferences local `$ref` values, strips unsupported schema keys such as `$defs`, `additionalProperties`, `title`, and `default`, and flattens historical tool activity into text-compatible replay. When requested, it combines function declarations with Google Search grounding and maps explicit `reasoningEffort` to Gemini `thinkingConfig` budgets.

Shared boundary:
- No adapter executes tools.
- No adapter owns persistence or turn-loop policy.
- Shared helpers in `src/provider-utils.ts` intentionally keep logging quiet and id generation package-local.

Read this with [[src-runtime]] when a provider-specific bug appears during message conversion, tool-call replay, or streamed output handling. For the new per-call search surface, see [[web-search-across-providers]].
