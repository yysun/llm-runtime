---
title: "Web Search Across Providers"
type: "concept"
status: "active"
source_paths:
  - "README.md"
  - ".docs/req/2026/04/20/req-web-serch-option.md"
  - ".docs/plans/2026/04/20/plan-web-serch-option.md"
  - ".docs/done/2026/04/22/web-serch-option.md"
  - "src/types.ts"
  - "src/runtime.ts"
  - "src/openai-direct.ts"
  - "src/anthropic-direct.ts"
  - "src/google-direct.ts"
  - "tests/llm/runtime-provider.test.ts"
  - "tests/llm/openai-direct.test.ts"
  - "tests/llm/anthropic-direct.test.ts"
  - "tests/llm/google-direct.test.ts"
updated_at: "2026-04-23"
---

`llm-runtime` now exposes web search as a public per-call capability instead of leaving it as provider-specific caller logic.

Facts from source:
- `LLMGenerateOptions` and `LLMStreamOptions` accept `webSearch?: boolean | LLMWebSearchOptions`.
- `webSearch: true` normalizes to an empty provider-default config; `webSearch: false` and omission both leave search disabled.
- The runtime does not enable web search implicitly for generic OpenAI-compatible targets. It only forwards the option when the caller asks for it.

Provider mapping:
- OpenAI, Azure OpenAI, XAI, generic `openai-compatible` backends, and Ollama all receive OpenAI-style `web_search_options`. `searchContextSize` is forwarded for these paths when present.
- Anthropic enables its built-in `web_search_20250305` server tool. Search activity stays provider-side: Anthropic server search blocks are not turned into host-visible `tool_calls`.
- Gemini adds `googleSearchRetrieval` alongside any function declarations. Gemini ignores `searchContextSize`, but still accepts the boolean-or-object public surface so the runtime call shape stays consistent.

Design intent:
- The runtime keeps one portable API while allowing each adapter to map search into the provider-native mechanism.
- Search remains orthogonal to tool execution. Host tools still come from built-ins, extra tools, or MCP; provider-native search does not become a host tool unless the provider itself emits a client tool call.

Tests back this in two layers: `tests/llm/runtime-provider.test.ts` proves the runtime forwards or suppresses `webSearch` correctly by provider, while the adapter suites assert the exact provider payloads and the Anthropic/Gemini suppression rules.

Read this with [[src-runtime]], [[provider-adapters]], and [[testing-and-showcases]].
