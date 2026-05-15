# Requirement: Runtime API Rename

**Date**: 2026-05-15
**Type**: Public API Naming / Compatibility
**Status**: Implemented

## Overview

Align the public runtime surface with the `agentic-complete.ts` naming model so the top-level package API reads as runtime creation plus generate/complete/stream-complete helpers, while preserving the existing tool model.

## Problem Statement

The current public API still exposes a runtime facade method named `stream(...)`, while the repo already has an `agentic-complete.ts` surface that clearly separates one-shot generation, buffered agentic completion, and streaming agentic completion as `generate(...)`, `complete(...)`, and `streamComplete(...)`.

That mismatch makes the public runtime harder to explain, leaves the primary API inconsistent with the agentic helper module, and keeps a runtime method name that is now too generic for what is specifically streaming completion-loop behavior.

The package needs the public runtime facade to adopt the `agentic-complete` naming model, remove `runtime.stream`, and leave the existing tool-resolution and tool-execution behavior unchanged.

## Goals

- Make the primary public path read as `createRuntime(...).complete(...)`.
- Make the runtime facade read as `createRuntime(...).generate(...)`, `createRuntime(...).complete(...)`, and `createRuntime(...).streamComplete(...)`.
- Rename the lower-level loop API from `runTurnLoop(...)` to `runCompletionLoop(...)`.
- Rename `respondWithTools(...)` to `complete(...)` as the preferred package-owned loop helper.
- Rename `createLLMEnvironment(...)` to `createRuntime(...)` and make it a facade that returns callable runtime helpers plus `dispose()`.
- Remove `runtime.stream(...)` from the public runtime facade.
- Rename `disposeLLMRuntimeCaches()` to `disposeRuntimeCaches()`.
- Rename human-input docs/examples from `human_intervention_request` wording to `ask_user_input` where the content is describing preferred usage.
- Preserve old exported names as deprecated aliases so existing callers continue to work.

## Non-Goals

- Remove legacy aliases in this change.
- Redesign provider-specific request behavior.
- Change the runtime ownership boundary for tool execution, MCP, skill registries, or built-in tool exposure beyond the new facade shape.
- Change tool definitions, tool resolution, or tool execution semantics.
- Rename or remove the top-level per-call `stream(...)` export.
- Rewrite unrelated historical RPD docs or wiki content.

## Functional Requirements

- **REQ-1**: The package must export `runCompletionLoop(...)` as the preferred lower-level completion-loop API.
- **REQ-2**: The package must continue exporting `runTurnLoop(...)` as a deprecated alias of `runCompletionLoop(...)`.
- **REQ-3**: Public `RunTurnLoop*` type names must gain `RunCompletionLoop*` counterparts.
- **REQ-4**: Existing `RunTurnLoop*` type names must remain available as deprecated aliases to the new type names.
- **REQ-5**: The package must export `complete(...)` as the preferred package-owned completion helper.
- **REQ-6**: The package must continue exporting `respondWithTools(...)` as a deprecated alias of `complete(...)`.
- **REQ-7**: The package must export `createRuntime(...)` as the preferred runtime-construction API.
- **REQ-8**: `createRuntime(...)` must return a facade object with `generate`, `complete`, `streamComplete`, `resolveTools`, and `dispose` methods.
- **REQ-9**: The package must continue exporting `createLLMEnvironment(...)` as a deprecated compatibility alias.
- **REQ-10**: The package must continue exporting `disposeLLMEnvironment(...)`, but its preferred replacement must be `runtime.dispose()`.
- **REQ-11**: The package must export `disposeRuntimeCaches()` as the preferred cache cleanup API.
- **REQ-12**: The package must continue exporting `disposeLLMRuntimeCaches()` as a deprecated alias of `disposeRuntimeCaches()`.
- **REQ-13**: Built-in human-input documentation and examples must prefer `ask_user_input` over `human_intervention_request`.
- **REQ-14**: Any old names retained for compatibility in public code must carry JSDoc deprecation markers for the names listed in `rename.md`.
- **REQ-15**: The primary README flow must show `createRuntime(...).complete(...)`.
- **REQ-16**: The advanced README flow must show `runCompletionLoop(...)`.
- **REQ-17**: `runtime.generate(...)` must remain the one-shot non-agentic call surface.
- **REQ-18**: `runtime.complete(...)` must expose the buffered agentic completion surface.
- **REQ-19**: `runtime.streamComplete(...)` must expose the streaming agentic completion surface.
- **REQ-20**: `runtime.stream(...)` must no longer be exposed on the public runtime facade.
- **REQ-20a**: The top-level per-call `stream(...)` export must remain available and unchanged.
- **REQ-21**: Existing automated tests must be updated so they validate the renamed preferred API while preserving compatibility behavior where relevant, except for `runtime.stream(...)`, which is intentionally removed.
- **REQ-22**: Existing tool definitions, tool resolution, and tool execution behavior must remain unchanged by this API rename.

## Non-Functional Requirements

- **NFR-1 (Compatibility)**: Existing TypeScript and JavaScript callers using legacy exported names should continue working without behavioral regressions, except for the intentional removal of `runtime.stream(...)`.
- **NFR-2 (Clarity)**: The preferred API names should make the public mental model easier to explain in docs and examples.
- **NFR-3 (Minimality)**: The rename should avoid unrelated behavior changes and keep the implementation focused on surface-level API semantics.

## Constraints

- Keep the package publishable and the public exports explicit.
- Preserve existing runtime behavior unless the rename requires the thin facade change from `stream(...)` to `streamComplete(...)`.
- Keep the runtime facade semantics aligned with the public concepts already defined in `src/agentic-complete.ts`.
- Maintain the current package style and file-comment-block convention for edited source files.

## Acceptance Criteria

- [x] `createRuntime(...)` is exported and returns a facade object with `generate`, `complete`, `streamComplete`, `resolveTools`, and `dispose`.
- [x] `runtime.stream(...)` is removed from the public runtime facade.
- [x] `runCompletionLoop(...)` and `complete(...)` are exported and documented as the preferred APIs.
- [x] Deprecated aliases remain exported and behave as pass-through compatibility surfaces where this requirement keeps them.
- [x] Public completion-loop types have renamed preferred exports plus compatibility aliases.
- [x] README examples and package guidance use the new preferred runtime method names.
- [x] Automated tests pass for the impacted runtime and completion-loop surfaces, including the intentional absence of `runtime.stream(...)`.
- [x] Tool behavior remains unchanged after the public API rename.

## References

- `rename.md`
- `README.md`
- `src/agentic-complete.ts`
- `src/index.ts`
- `src/runtime.ts`
- `src/turn-loop.ts`
- `src/types.ts`
