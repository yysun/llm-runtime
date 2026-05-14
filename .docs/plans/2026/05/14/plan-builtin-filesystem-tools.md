# Plan: Built-In Filesystem Tools

**Date**: 2026-05-14
**Requirement**: `.docs/reqs/2026/05/14/req-builtin-filesystem-tools.md`
**Status**: Implemented

## Overview

Replace the built-in `grep` tool with three filesystem-oriented built-ins: `search_files`, `create_directory`, and `path_exists`.

The work must keep the runtime's built-in tool type surface, catalog, executor registry, validation aliases, public README, and test coverage aligned so the package exposes one consistent built-in contract.

## Current State

- `src/types.ts` still exposes `grep` in `BuiltInToolName`.
- `src/builtins.ts` still reserves `grep` in `BUILT_IN_TOOL_NAMES` and defines its schema and description.
- `src/builtin-executors.ts` still implements and exports a `grep` executor, but has no built-in equivalents for file search, directory creation, or path existence checks.
- `src/tool-validation.ts` contains `grep`-specific alias normalization branches.
- `README.md` documents `grep` as a reserved built-in tool.
- `tests/llm/runtime.test.ts` expects `grep` in the resolved built-in set.
- Several E2E dry-run showcase files explicitly disable `grep` in built-in selections.

## Design

### Built-In Catalog Changes

- Remove `grep` from the public built-in name union and from `BUILT_IN_TOOL_NAMES`.
- Add `search_files`, `create_directory`, and `path_exists` everywhere built-in names are enumerated.
- Keep `ask_user_input` and `human_intervention_request` synchronization unchanged.

### Tool Schemas

- `search_files` should accept a path-oriented query suitable for file discovery rather than content matching.
- `create_directory` should accept a required target path and create parent directories recursively.
- `path_exists` should accept a required target path and report existence plus basic type information when available.
- Keep schemas shallow, consistent with the current built-in JSON-schema style, and compatible with the package validator.

### Executor Strategy

- Reuse trusted working-directory enforcement through `resolveScopedPath(...)`.
- Implement `search_files` on top of `fast-glob` so it returns deterministic, sorted results.
- Implement `create_directory` with `fs.mkdir(..., { recursive: true })` and a compact JSON success artifact.
- Implement `path_exists` with `fs.stat(...)` and a compact JSON result that clearly communicates whether the path exists and whether it is a file or directory.
- Remove the unused `grep` helper constants, recursive file collector, and executor wiring once the new tools are in place.

### Validation And Compatibility

- Remove `grep` alias normalization logic.
- Add narrow alias normalization only where it improves compatibility for the new tools, such as mapping `directory` to `path` for `create_directory` if needed.
- Keep validation shallow; avoid expanding the validator into a full glob or filesystem semantics engine.

### Test Scope

- Update unit coverage to assert the new default built-in catalog.
- Add focused runtime tests for successful execution of `search_files`, `create_directory`, and `path_exists`.
- Add a negative validation test showing `grep` is no longer a supported built-in selection.
- Update dry-run fixture-style tests and examples that enumerate disabled built-ins.

### E2E Coverage Decision

- No dedicated E2E spec is required. This story is an internal built-in contract change with targeted unit coverage and dry-run config updates, not a user-facing interactive flow.

## Implementation Tasks

- [x] Inspect relevant files
  - Confirmed built-in catalog references in source, README, wiki, and tests.
  - Confirmed existing examples only used `grep` in enablement toggles, not runtime behavior.
- [x] Make focused changes
  - Updated the built-in name union and catalog.
  - Implemented `search_files`, `create_directory`, and `path_exists` executors.
  - Removed `grep` executor and validation branches.
  - Updated README, wiki, and affected dry-run examples.
- [x] Run validation
  - Ran targeted unit tests for runtime behavior.
  - Ran the project `check` script.
  - Ran the dry-run E2E showcase command.
- [x] Update docs/status
  - Marked completed plan tasks.
  - Recorded architecture review outcomes in this document.
  - Added the done doc with verification evidence.

## Architecture Review

### Review Status

Completed.

### Review Findings

- **Remove `grep` completely rather than leaving a hidden alias.** Keeping `grep` as an undocumented alias would undermine the goal of simplifying the built-in surface and would preserve dead validation and executor code.
- **Use file-discovery semantics for `search_files`.** Reusing content-search semantics under a new name would make the new tool misleading and would not address the requirement gap.
- **Keep the result shapes compact and deterministic.** These tools are likely to be consumed by agents, so sorted entries and explicit `found` or `exists` flags are preferable to prose-heavy responses.
- **Do not add E2E coverage for this change.** The story is internal and already has strong unit-test leverage through the runtime package tests and dry-run showcases.

### Decisions

- `search_files` will be a file-discovery tool, not a content-search tool.
- `create_directory` will create parent directories recursively and succeed idempotently when the directory already exists.
- `path_exists` will return existence and basic path-kind information.
- `grep` will be removed from types, catalog, validation, executors, docs, and tests in the same change.

### Residual Risks

- Callers that still try to enable `grep` via typed configs will fail at compile time after the type update, which is intentional but potentially breaking.
- Any downstream examples outside this repository that assume `grep` exists will need to move to `search_files` or external tools.

## Verification

- `vitest` unit suite passed: 85 tests.
- `npm run check` passed.
- `npm run test:e2e:dry-run` passed with `hitl-strict-schema=ok` and `dry-run=ok`.
- `git diff --check` passed.