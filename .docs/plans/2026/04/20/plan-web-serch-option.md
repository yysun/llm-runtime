# Architecture Plan: Cross-Provider Per-Call Web Search

**Date**: 2026-04-20
**Status**: Completed
**Requirement**: `.docs/req/2026/04/20/req-web-serch-option.md`

## Objective

Add a package-owned per-call web-search option to `llm-runtime` and support all package providers through their provider-native request shapes.

## Current Architecture Summary

- `src/runtime.ts` already resolves package-owned request defaults such as reasoning effort and routes OpenAI-like providers through one runtime dispatch path.
- `src/openai-direct.ts` owns Chat Completions request construction for OpenAI and Azure OpenAI.
- `src/anthropic-direct.ts` owns Anthropic request construction and can attach Anthropic's built-in web search server tool.
- `src/google-direct.ts` owns Gemini request construction and is the correct boundary for enabling Google Search grounding.
- `src/types.ts` defines the public request contract and currently has no web-search option.
- The implementation is already present in the working tree, so `SS` here is primarily a reconciliation step: verify that the landed code matches the requirement and document the outcome.

## Architecture Review

### Decision 1: Keep the public surface package-owned

Expose a package-native `webSearch` option in `LLMPerCallProviderOptions` instead of leaking raw OpenAI SDK request types into the public API.

Why:

- keeps the runtime API stable and provider-agnostic at the package boundary
- allows the runtime to enforce precedence and validation rules centrally
- preserves flexibility if the internal OpenAI request mapping changes later

### Decision 2: Resolve web-search behavior from the per-call request

Per-call option normalization belongs in the runtime orchestration layer, not the provider adapter.

Why:

- request normalization is package runtime policy rather than provider transport logic
- the runtime already owns per-call option resolution before dispatching into providers
- this keeps `src/openai-direct.ts` focused on request translation

### Decision 3: Keep provider-specific request mapping in the provider adapters

The provider adapters should translate package-native `webSearch` options into the provider-specific request shape.

Why:

- it preserves a clean runtime-to-provider boundary
- it localizes SDK-field naming to the relevant provider adapter
- it reduces the chance of provider-specific conditionals leaking across the runtime

### Decision 4: Accept one option across the package provider set

The runtime should only enable web search when the caller passes `webSearch` on the request, and that per-call option should map provider-natively where possible while using explicit best-effort forwarding for generic `openai-compatible` and `ollama` backends.

Why:

- it makes request behavior fully explicit for package consumers
- it avoids accidental behavior changes from hidden global defaults
- it still keeps provider-specific mapping inside the adapters
- it avoids overstating capabilities for generic backends that only receive forwarded OpenAI-shape fields

## Risks And Mitigations

- Risk: provider adapters may diverge in how they represent web search.
  Mitigation: keep a single package-owned `webSearch` input while mapping it independently in each provider adapter.

- Risk: the public Gemini helper surface could drift from the runtime path.
  Mitigation: make `createGoogleModel(...)` accept the richer structured tool array as well as the legacy function-declaration array.

- Risk: per-call override semantics could become ambiguous.
  Mitigation: define explicit precedence where request-level `webSearch` always wins.

## Implementation Plan

### Phase 1: Public request contract

- [x] Add a package-owned `webSearch` option and supporting types in `src/types.ts`.

### Phase 2: Runtime default resolution

- [x] Normalize the per-call `webSearch` option in `src/runtime.ts`.
- [x] Route the normalized `webSearch` option to every supported provider path.

### Phase 3: Provider request mapping

- [x] Map package-native web-search options to OpenAI-shape Chat Completions `web_search_options` in `src/openai-direct.ts`.
- [x] Map package-native web-search options to Anthropic's built-in web search server tool in `src/anthropic-direct.ts`.
- [x] Map package-native web-search options to Gemini Google Search grounding in `src/google-direct.ts`.
- [x] Omit provider-specific search fields when web search is not enabled.

### Phase 4: Verification and documentation

- [x] Add unit coverage for payload mapping and per-call behavior.
- [x] Update `README.md` with the public option and provider-specific behavior.
- [x] Run the focused tests covering OpenAI request building and runtime provider dispatch.

## SS Notes

The code implementing this plan was already present in the working tree when the plan was approved. `SS` verified that the implementation satisfies the requirement, updated the plan to reflect completed phases, and confirmed the targeted tests passed.

## Verification

- `tests/llm/openai-direct.test.ts`: passed
- `tests/llm/google-direct.test.ts`: passed
- `tests/llm/runtime-provider.test.ts`: passed
- `src/types.ts`: no current errors
- `src/runtime.ts`: no current errors
- `src/openai-direct.ts`: no current errors
- `src/google-direct.ts`: no current errors