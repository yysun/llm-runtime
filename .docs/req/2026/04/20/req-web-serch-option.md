# Requirement: Cross-Provider Per-Call Web Search

**Date**: 2026-04-20
**Type**: Runtime API / Provider Configuration
**Status**: Completed

## Overview

Allow `llm-runtime` callers to enable provider-native web search through a package-owned per-call option while treating generic `openai-compatible` and `ollama` backends as explicit best-effort OpenAI-shape pass-through.

## Problem Statement

The runtime already exposes provider request options such as reasoning effort and token limits, but it does not yet provide a package-owned way to turn on supported provider web search per request.

Without that support:

- callers must wire provider-specific flags outside the runtime
- the package API does not expose an explicit per-call web-search contract
- tests and docs do not define how OpenAI-shape and Gemini web search requests should behave

## Goals

- Allow the package provider set to accept one package-owned per-call web-search option.
- Preserve a package-owned per-call override in the public request surface.
- Forward the Chat API web-search flag using the native request shape expected by the OpenAI SDK.
- Document that `openai-compatible` and `ollama` use best-effort OpenAI-shape forwarding rather than guaranteed provider-native support.
- Keep the behavior scoped to the package's supported provider set: OpenAI, Azure OpenAI, Anthropic, Gemini, xAI, OpenAI-compatible endpoints, and Ollama.
- Add tests and docs so callers know how the per-call option behaves.

## Non-Goals

- Adding provider-native web search support to providers outside the package's supported provider set.
- Moving the runtime from Chat Completions to the Responses API in this requirement.
- Adding user-location configuration or broader search-policy controls beyond the existing Chat API flag and context-size option.

## Functional Requirements

### Public API

- **REQ-1**: The per-call request surface must expose a package-owned `webSearch` option.
- **REQ-2**: The per-call `webSearch` option must allow callers to enable web search without specifying additional options.
- **REQ-3**: The per-call `webSearch` option must allow callers to specify search context size for providers that support that option.
- **REQ-4**: The per-call `webSearch` option must allow callers to explicitly disable web search for that request.

### Provider Request Mapping

- **REQ-9**: When web search is enabled for an OpenAI-shape provider, the runtime must forward the native Chat Completions `web_search_options` request field.
- **REQ-10**: When a search context size is configured for an OpenAI-shape provider, the runtime must forward it using the SDK field name expected by the Chat Completions API.
- **REQ-11**: When web search is enabled for Anthropic, the runtime must enable Anthropic's built-in web search server tool.
- **REQ-11a**: When web search is enabled for Gemini, the runtime must enable the SDK’s Google Search grounding tool.
- **REQ-11b**: Generic `openai-compatible` providers and Ollama may receive explicit per-call web-search options through the OpenAI-compatible request path on a best-effort basis.

### Request Semantics

- **REQ-12**: `webSearch: false` or an omitted `webSearch` field must leave web search disabled for that request.
- **REQ-13**: `webSearch: true` must enable web search for that request.
- **REQ-14**: `webSearch: { ... }` must enable web search for that request using the provided options.

### Tests And Documentation

- **REQ-15**: Automated coverage must verify that OpenAI request payloads include `web_search_options` when enabled.
- **REQ-16**: Automated coverage must verify that Anthropic and Gemini requests enable their provider-native web-search tools when web search is enabled.
- **REQ-17**: Automated coverage must verify the enabled and disabled request behavior of the per-call option across the supported provider set.
- **REQ-18**: Public docs must explain the new request option and provider-specific behavior.

## Non-Functional Requirements

- **NFR-1 (Compatibility)**: The change must be additive and must not break existing callers that do not use web search.
- **NFR-2 (Safety)**: Provider-specific web-search mappings must not produce malformed provider payloads.
- **NFR-3 (Scope Control)**: The behavior must remain limited to the package's supported provider set unless a later requirement expands it.
- **NFR-4 (Clarity)**: The runtime docs must describe the request option clearly enough for package consumers to configure it without reading source code.

## Constraints

- The implementation must use the existing Chat Completions provider path in `src/openai-direct.ts` and the existing Gemini adapter in `src/google-direct.ts`.
- The runtime must preserve existing provider dispatch behavior outside the additive web-search request fields.
- The public request contract must remain package-owned rather than exposing raw SDK types directly.

## Acceptance Criteria

- [x] `generate(...)` and `stream(...)` accept a `webSearch` request option.
- [x] OpenAI Chat Completions requests include `web_search_options` when web search is enabled.
- [x] Anthropic requests enable the built-in web search server tool when web search is enabled.
- [x] Generic `openai-compatible` providers and Ollama still accept explicit per-call `webSearch` options as best-effort OpenAI-shape pass-through.
- [x] OpenAI-shape providers still accept per-call `searchContextSize` when explicitly requested.
- [x] Omitting `webSearch` or passing `webSearch: false` leaves web search disabled.
- [x] Tests cover payload mapping and per-call enabled and disabled behavior across the supported providers.
- [x] `README.md` documents the public option and provider-specific behavior.

## SS Verification

- Focused unit coverage passed for `tests/llm/openai-direct.test.ts`, `tests/llm/google-direct.test.ts`, and `tests/llm/runtime-provider.test.ts`.
- `src/types.ts`, `src/runtime.ts`, `src/openai-direct.ts`, and `src/google-direct.ts` report no current errors.

## References

- `src/types.ts`
- `src/runtime.ts`
- `src/openai-direct.ts`
- `src/google-direct.ts`
- `README.md`
- `tests/llm/openai-direct.test.ts`
- `tests/llm/google-direct.test.ts`
- `tests/llm/runtime-provider.test.ts`