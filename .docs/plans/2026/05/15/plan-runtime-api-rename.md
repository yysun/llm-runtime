# Architecture Plan: Runtime API Rename

**Date**: 2026-05-15
**Status**: Implemented
**Requirement**: `.docs/reqs/2026/05/15/req-runtime-api-rename.md`

## Objective

Reframe the public API around a runtime facade and completion loop while keeping the old environment and turn-loop names as compatibility aliases.

## Architecture Summary

- `src/runtime.ts` currently exports low-level runtime helpers plus explicit environment construction and disposal.
- `src/turn-loop.ts` owns the generic iterative tool loop and already contains the preferred package-owned wrapper behavior.
- `src/index.ts` defines the public export surface.
- `README.md` and several tests still present the older environment and turn-loop naming as the primary experience.

## Design Decisions

### Preferred naming

- Introduce `runCompletionLoop(...)` as the new primary name for the generic loop implementation.
- Introduce `complete(...)` as the new primary name for the package-owned default wrapper.
- Introduce `createRuntime(...)` as a facade that closes over an environment and exposes bound helper methods.

### Compatibility strategy

- Keep the old function names as exported aliases.
- Use JSDoc `@deprecated` markers directly on compatibility exports and compatibility type aliases.
- Keep the underlying environment object shape unchanged so existing call paths still work.

### File strategy

- Create `src/completion-loop.ts` as the preferred file and keep `src/turn-loop.ts` as a compatibility re-export layer.
- Minimize logic duplication by placing the real implementation in one file only.

### Testing strategy

- Update unit tests to import and exercise the preferred names.
- Preserve a smaller amount of compatibility coverage for legacy names.
- Run TypeScript validation and the focused llm test suite.

### E2E decision

- No new `.docs/tests/test-runtime-api-rename.md` spec is needed.
- Reason: this change is a public API rename with no new end-user workflow; the existing executable showcase and provider dry-run scripts are the relevant integration coverage and can be updated without adding a separate markdown scenario file.

## Review Notes

- Alternative considered: keep `createLLMEnvironment(...)` as the only constructor and just rewrite docs. Rejected because it leaves the public model inconsistent with the desired API contract.
- Alternative considered: fully remove legacy names. Rejected because the requirement explicitly preserves compatibility.
- Main risk: widening the runtime facade too much. Mitigation: expose only already-public helpers bound to the created environment and keep all other behavior unchanged.

## Tasks

- [x] Inspect relevant files
- [x] Make focused changes
- [x] Run validation
- [x] Update docs/status

