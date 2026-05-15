# Requirement: Runtime API Rename

**Date**: 2026-05-15
**Type**: Public API Naming / Compatibility
**Status**: Implemented

## Overview

Rename the main public runtime concepts so the package surface reads in terms of runtime creation and completion loops instead of environments and turn loops, while preserving backward compatibility through deprecated aliases.

## Problem Statement

The current public API mixes older names such as `createLLMEnvironment(...)`, `respondWithTools(...)`, and `runTurnLoop(...)` with newer package behavior that is really a runtime facade plus a completion loop. That creates friction in the README, makes the primary path harder to explain, and leaves the public API less cohesive than the implementation.

The package needs a rename that improves the user-facing mental model without breaking existing callers.

## Goals

- Make the primary public path read as `createRuntime(...).complete(...)`.
- Rename the lower-level loop API from `runTurnLoop(...)` to `runCompletionLoop(...)`.
- Rename `respondWithTools(...)` to `complete(...)` as the preferred package-owned loop helper.
- Rename `createLLMEnvironment(...)` to `createRuntime(...)` and make it a facade that returns callable runtime helpers plus `dispose()`.
- Rename `disposeLLMRuntimeCaches()` to `disposeRuntimeCaches()`.
- Rename human-input docs/examples from `human_intervention_request` wording to `ask_user_input` where the content is describing preferred usage.
- Preserve old exported names as deprecated aliases so existing callers continue to work.

## Non-Goals

- Remove legacy aliases in this change.
- Redesign provider-specific request behavior.
- Change the runtime ownership boundary for tool execution, MCP, or skill registries beyond the new facade shape.
- Rewrite unrelated historical RPD docs or wiki content.

## Functional Requirements

- **REQ-1**: The package must export `runCompletionLoop(...)` as the preferred lower-level completion-loop API.
- **REQ-2**: The package must continue exporting `runTurnLoop(...)` as a deprecated alias of `runCompletionLoop(...)`.
- **REQ-3**: Public `RunTurnLoop*` type names must gain `RunCompletionLoop*` counterparts.
- **REQ-4**: Existing `RunTurnLoop*` type names must remain available as deprecated aliases to the new type names.
- **REQ-5**: The package must export `complete(...)` as the preferred package-owned completion helper.
- **REQ-6**: The package must continue exporting `respondWithTools(...)` as a deprecated alias of `complete(...)`.
- **REQ-7**: The package must export `createRuntime(...)` as the preferred runtime-construction API.
- **REQ-8**: `createRuntime(...)` must return a facade object with `generate`, `stream`, `complete`, `resolveTools`, and `dispose` methods.
- **REQ-9**: The package must continue exporting `createLLMEnvironment(...)` as a deprecated compatibility alias.
- **REQ-10**: The package must continue exporting `disposeLLMEnvironment(...)`, but its preferred replacement must be `runtime.dispose()`.
- **REQ-11**: The package must export `disposeRuntimeCaches()` as the preferred cache cleanup API.
- **REQ-12**: The package must continue exporting `disposeLLMRuntimeCaches()` as a deprecated alias of `disposeRuntimeCaches()`.
- **REQ-13**: Built-in human-input documentation and examples must prefer `ask_user_input` over `human_intervention_request`.
- **REQ-14**: Any old names retained for compatibility in public code must carry JSDoc deprecation markers for the names listed in `rename.md`.
- **REQ-15**: The primary README flow must show `createRuntime(...).complete(...)`.
- **REQ-16**: The advanced README flow must show `runCompletionLoop(...)`.
- **REQ-17**: Existing automated tests must be updated so they validate the renamed preferred API while preserving compatibility behavior where relevant.

## Non-Functional Requirements

- **NFR-1 (Compatibility)**: Existing TypeScript and JavaScript callers using legacy names should continue working without behavioral regressions.
- **NFR-2 (Clarity)**: The preferred API names should make the public mental model easier to explain in docs and examples.
- **NFR-3 (Minimality)**: The rename should avoid unrelated behavior changes and keep the implementation focused on surface-level API semantics.

## Constraints

- Keep the package publishable and the public exports explicit.
- Preserve existing runtime behavior unless the rename requires a thin facade change.
- Maintain the current package style and file-comment-block convention for edited source files.

## Acceptance Criteria

- [x] `createRuntime(...)` is exported and returns a facade object with `generate`, `stream`, `complete`, `resolveTools`, and `dispose`.
- [x] `runCompletionLoop(...)` and `complete(...)` are exported and documented as the preferred APIs.
- [x] Deprecated aliases remain exported and behave as pass-through compatibility surfaces.
- [x] Public completion-loop types have renamed preferred exports plus compatibility aliases.
- [x] README examples and package guidance use the new preferred names on the primary and advanced paths.
- [x] Unit tests pass for the impacted runtime and completion-loop surfaces.

## References

- `rename.md`
- `README.md`
- `src/index.ts`
- `src/runtime.ts`
- `src/turn-loop.ts`
- `src/types.ts`
