---
title: "Provider Adapters"
type: "concept"
status: "active"
source_paths:
  - "README.md"
  - "src/openai-direct.ts"
  - "src/anthropic-direct.ts"
  - "src/google-direct.ts"
  - "src/provider-tool-names.ts"
  - "src/provider-utils.ts"
  - "tests/llm/openai-direct.test.ts"
  - "tests/llm/anthropic-direct.test.ts"
  - "tests/llm/google-direct.test.ts"
  - "tests/llm/provider-tool-names.test.ts"
updated_at: "2026-04-23"
---

The provider modules are the translation layer between `llm-runtime` and each model vendor.

In plain terms, they take the package's common message and tool format, rewrite it into whatever OpenAI, Anthropic, or Google expects, then turn the reply back into the shared `LLMResponse` shape used by the rest of the package.

Differences by adapter:
- `src/openai-direct.ts` covers OpenAI, Azure OpenAI, XAI, Ollama, and generic OpenAI-compatible endpoints through one chat-completions adapter. It forwards `reasoningEffort` as `reasoning_effort`, forwards per-call `webSearch` as `web_search_options`, normalizes historical tool-call ids to fit OpenAI's 40-character limit, and now preserves additive stop metadata through normalized `stopKind` plus provider-native `providerStopReason`.
- `src/anthropic-direct.ts` extracts the system prompt into Anthropic's `system` field, replays tool history through `tool_use` and `tool_result` blocks, and adds Anthropic's built-in `web_search_20250305` server tool when `webSearch` is enabled. Server-side web-search blocks are intentionally kept provider-local and do not surface as host `tool_calls`, and the adapter now preserves Anthropic `stop_reason` values on `LLMResponse.providerStopReason`.
- `src/google-direct.ts` converts tool schemas into Gemini declarations, dereferences local `$ref` values, strips unsupported schema keys such as `$defs`, `additionalProperties`, `title`, and `default`, and flattens historical tool activity into text-compatible replay. When requested, it combines function declarations with Google Search grounding, maps explicit `reasoningEffort` to Gemini `thinkingConfig` budgets, and preserves Gemini `finishReason` as additive stop metadata.

Shared boundary:
- No adapter executes tools.
- No adapter owns persistence or turn-loop policy.
- Shared helpers in `src/provider-utils.ts` intentionally keep logging quiet and id generation package-local.
- Function-calling adapters now also share `src/provider-tool-names.ts`, which sanitizes runtime tool names into provider-safe names, avoids reserved provider names, keeps long names bounded with deterministic hashes, and preserves reverse lookup so executed tools still resolve to the original runtime name.

Read this with [[src-runtime]] when a provider-specific bug appears during message conversion, tool-call replay, or streamed output handling. For the shared name-translation helper, see [[src-provider-tool-names]]. For the new per-call search surface, see [[web-search-across-providers]].
