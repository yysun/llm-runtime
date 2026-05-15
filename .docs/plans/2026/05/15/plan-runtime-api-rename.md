# Architecture Plan: Runtime API Rename

**Date**: 2026-05-15
**Status**: Implemented
**Requirement**: `.docs/reqs/2026/05/15/req-runtime-api-rename.md`

## Objective

Re-align the public runtime facade with the `agentic-complete.ts` naming model so `createRuntime(...)` exposes `generate(...)`, `complete(...)`, and `streamComplete(...)`, while removing `runtime.stream(...)` and keeping tool behavior unchanged.

## Architecture Summary

- `src/runtime.ts` currently binds `generate(...)`, `stream(...)`, `complete(...)`, tool resolution, tool execution, and disposal onto the runtime facade returned by `createRuntime(...)`.
- `src/types.ts` defines `LLMRuntime` and currently hard-codes `stream` as part of the public runtime interface.
- `src/index.ts` exports the top-level package surface, including the runtime facade constructor and the per-call `stream(...)` helper.
- `README.md` and `tests/llm/runtime.test.ts` currently document and assert the old runtime facade shape.
- `src/agentic-complete.ts` already establishes the naming model this requirement wants the public runtime facade to follow: `generate(...)`, `complete(...)`, and `streamComplete(...)`.

## Design Decisions

### Runtime facade boundary

- Replace the runtime facade method `stream(...)` with `streamComplete(...)`.
- Keep `runtime.generate(...)` as the one-shot non-agentic method.
- Keep `runtime.complete(...)` as the buffered package-owned completion-loop helper.
- Bind `runtime.streamComplete(...)` to the existing streaming completion path instead of introducing new streaming semantics.

### Compatibility boundary

- Preserve the existing deprecated aliases for environment and completion-loop naming that the requirement still keeps.
- Do not preserve `runtime.stream(...)`; its removal is the intentional runtime-facade break in this story.
- Keep the top-level per-call `stream(...)` export unchanged so provider-level streaming callers are not pulled into an unrelated migration.
- Update public types so the break is explicit at compile time for runtime-facade consumers.

### Implementation shape

- Reuse the existing runtime-bound streaming logic in `src/runtime.ts` rather than introducing a second runtime orchestration path.
- Rename only the runtime-facade method and its associated runtime-scoped option/type names where needed; do not change tool registries, built-ins, or execution helpers.
- Update file comment blocks in any edited source file to reflect the new preferred runtime facade shape.

### Testing strategy

- Update runtime tests to assert `streamComplete` exists and `stream` is absent on the runtime facade.
- Keep turn-loop and lower-level completion-loop compatibility coverage focused on `runCompletionLoop(...)`, `runTurnLoop(...)`, `complete(...)`, and `respondWithTools(...)`.
- Run `npm run check` and focused runtime-related unit coverage after the rename.

### E2E decision

- No new `.docs/tests/test-runtime-api-rename.md` spec is needed.
- Reason: this is a narrow public API surface adjustment with no new end-user workflow and no change to tool semantics.

## Architecture Review

- Review outcome: proceed with a narrow facade rename in place.
- Alternative considered: keep `runtime.stream(...)` and add `runtime.streamComplete(...)` as an alias. Rejected because the requirement explicitly removes the old runtime method and a dual surface would keep the public mental model muddy.
- Alternative considered: rename the top-level per-call `stream(...)` export at the same time. Rejected because the user request only targets the runtime facade and the per-call provider API is a different concept with existing callers.
- Primary risk: implementation drift between runtime-bound `streamComplete(...)` and the lower-level completion-loop streaming path. Mitigation: bind `streamComplete(...)` to the existing completion-loop stream helper rather than adding new behavior.
- Primary compatibility break: TypeScript callers using `runtime.stream(...)` will fail at compile time after the interface update. Mitigation: document the migration in the README examples and runtime tests, and keep the rest of the runtime/tool surface stable.
- Tooling risk: accidental changes to built-in exposure or execution helpers while touching `src/runtime.ts` and `src/types.ts`. Mitigation: keep tool-resolution and tool-execution logic unchanged and preserve the existing runtime tests around `resolveTools`, `executeToolCall`, and `executeToolCalls`.

## Tasks

- [x] Inspect relevant files
- [x] Make focused changes
- [x] Run validation
- [x] Update docs/status

