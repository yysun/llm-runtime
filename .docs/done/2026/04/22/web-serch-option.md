# Done: Cross-Provider Per-Call Web Search

**Date**: 2026-04-22
**Requirement**: `.docs/req/2026/04/20/req-web-serch-option.md`
**Plan**: `.docs/plans/2026/04/20/plan-web-serch-option.md`
**Status**: Completed

## Summary

Completed the package-owned per-call web-search support across the public request surface, provider adapters, runtime dispatch, tests, and package documentation for the package provider set.

The final design keeps web-search enablement explicit per request:

- callers opt in through `webSearch` on `generate(...)`, `stream(...)`, or turn-loop `modelRequest`
- OpenAI, Azure, and xAI receive OpenAI Chat Completions `web_search_options`
- `openai-compatible` and `ollama` receive best-effort OpenAI-shape `web_search_options` forwarding
- Anthropic receives its built-in web search server tool
- Gemini receives Google Search grounding

## Delivered

### Public per-call surface

- Added package-owned `webSearch?: boolean | LLMWebSearchOptions` to the shared per-call provider options in `src/types.ts`.
- Added `WebSearchContextSize` and `LLMWebSearchOptions` so callers can pass a package-native search context size without importing provider SDK types.

### Runtime and provider behavior

- Added runtime normalization for `webSearch` in `src/runtime.ts`.
- Extended the per-call web-search option across the package provider set, including Anthropic and best-effort pass-through for Ollama.
- Added OpenAI Chat Completions `web_search_options` mapping in `src/openai-direct.ts`.
- Added Anthropic built-in web search server-tool mapping in `src/anthropic-direct.ts`.
- Added Gemini Google Search grounding support in `src/google-direct.ts`.
- Updated `createGoogleModel(...)` to accept either legacy function-declaration arrays or structured Gemini tool arrays so the public helper surface stays aligned with the runtime path.

### Tests and docs

- Added OpenAI adapter coverage for forwarded `web_search_options`.
- Added runtime dispatch coverage for enabled and disabled behavior across Anthropic, Gemini, xAI, Azure, Ollama, and `openai-compatible`.
- Added Anthropic adapter coverage to verify that built-in server web-search blocks do not leak into host tool-call handling.
- Added Gemini helper coverage for search grounding plus the structured `createGoogleModel(...)` tool shape.
- Updated `README.md` to document `webSearch` as a per-call-only option and clarify provider-specific behavior.

## Verification

The following focused validation ran successfully:

- `tests/llm/anthropic-direct.test.ts`
- `tests/llm/openai-direct.test.ts`
- `tests/llm/google-direct.test.ts`
- `tests/llm/runtime-provider.test.ts`

The following files also reported no current errors during verification:

- `src/runtime.ts`
- `src/openai-direct.ts`
- `src/google-direct.ts`
- `tests/llm/runtime-provider.test.ts`
- `tests/llm/google-direct.test.ts`

## Review Outcome

Final code review found no remaining actionable issues in the current worktree after the follow-up fixes.

## Changed Areas

- `src/types.ts`
- `src/runtime.ts`
- `src/openai-direct.ts`
- `src/anthropic-direct.ts`
- `src/google-direct.ts`
- `README.md`
- `tests/llm/anthropic-direct.test.ts`
- `tests/llm/openai-direct.test.ts`
- `tests/llm/google-direct.test.ts`
- `tests/llm/runtime-provider.test.ts`
- `.docs/req/2026/04/20/req-web-serch-option.md`
- `.docs/plans/2026/04/20/plan-web-serch-option.md`