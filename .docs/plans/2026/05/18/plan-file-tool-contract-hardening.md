# Plan: File Tool Contract Hardening

**Date**: 2026-05-18
**Requirement**: `.docs/reqs/2026/05/18/req-file-tool-contract-hardening.md`
**Status**: Implemented

## Overview

Harden the built-in file-tool surface so the runtime contract, validation behavior, executor behavior, and public documentation stay aligned for `read_file`, `write_file`, `list_files`, `search_files`, `create_directory`, and `path_exists`.

The main implementation work is to remove the fixed hard `read_file` line cap from the public contract, eliminate the `read_file` scope fallback into skill roots, align required parameter validation with executor requirements, make hidden-path and exclusion behavior explicit, and tighten `path_exists` semantics around symlinks.

## Current State

- `src/builtin-executors.ts` caps `read_file.limit` to a fixed maximum of 200 lines and falls back to skill-root file reads when the workspace read misses.
- `src/builtins.ts` describes `read_file` as bounded line pagination and does not require a file path in the declared schema.
- `src/builtins.ts` only requires `content` for `write_file`, even though the executor also requires a target path.
- `src/builtin-executors.ts` defaults `includeHidden` to true for `list_files` and `search_files`, but also hard-excludes `.git`, `node_modules`, and `dist` regardless of caller intent.
- `src/builtin-executors.ts` uses `fs.stat(...)` in `path_exists`, which reports dangling symlinks as missing.
- `tests/llm/runtime.test.ts` covers happy paths for `search_files`, `create_directory`, `path_exists`, and one `read_file` helper case, but direct coverage for `write_file`, `list_files`, and the relevant edge cases is still thin.

## Design

### Contract Alignment

- Update the built-in tool schemas so required parameters reflect executor requirements.
- Keep alias normalization behavior where it improves compatibility, but make the declared schema the source of truth for validation.
- Update README wording so the documented file-tool behavior matches the final implementation.

### `read_file`

- Remove the fixed hard maximum line cap from the public contract and executor behavior.
- Preserve offset-based pagination so callers can still request slices of large files.
- Keep result metadata deterministic, including `filePath`, `offset`, `limit`, `totalLines`, and `content`.
- Restrict successful reads to the trusted working-directory scope; do not fall back to skill-root content for this built-in.

### `list_files` And `search_files`

- Make hidden-path behavior explicit and caller-controlled.
- Decide whether hard-coded exclusions remain part of the contract or become caller-visible and overridable. The preferred direction is to remove unconditional exclusions so the tools do what the caller asked within the trusted workspace.
- Preserve deterministic ordering and compact JSON results.

### `path_exists`

- Define the intended symlink contract explicitly.
- Prefer behavior that reports path presence consistently even for symlink edge cases, while still exposing file or directory information when resolvable.

### Test Scope

- Add focused unit coverage in `tests/llm/runtime.test.ts` for:
  - `read_file` without a hard line cap
  - validation failures for missing file-tool path arguments
  - `list_files` behavior around hidden or previously excluded paths
  - `write_file` happy-path behavior and validation contract
  - `path_exists` symlink semantics

### E2E Coverage Decision

- No dedicated E2E spec is needed. This is an internal built-in contract change with strong unit-test leverage and no new user-facing flow.

## Implementation Tasks

- [x] Inspect relevant files
  - Confirmed current requirement, built-in schemas, executor behavior, README contract, validation aliases, and runtime tests.
- [x] Make focused changes
  - Updated built-in schemas and descriptions in `src/builtins.ts`.
  - Updated executor behavior in `src/builtin-executors.ts`.
  - Kept validation aligned in `src/tool-validation.ts`.
  - Updated README wording in `README.md`.
  - Added focused contract coverage in `tests/llm/runtime.test.ts`.
- [x] Run validation
  - `tests/llm/runtime.test.ts` passed: 52 tests.
  - `npm run check` passed.
  - `npm test` passed: 157 tests.
- [x] Update docs/status
  - Marked plan progress as implementation completed.
  - Kept the REQ and plan aligned with the final contract wording.
  - Prepared the done doc after verification and review completion.

## Architecture Review

### Review Findings

- Removing the `read_file` hard cap is safe only if pagination remains available; the tool should stay slice-oriented, not become an uncontrolled whole-file dump by default.
- `read_file` should not silently cross from workspace scope into skill-root scope. That behavior belongs to skill loading, not to a workspace file primitive.
- Required path validation should be fixed in the schema rather than left as executor-only fallback errors; otherwise validation artifacts remain inconsistent with the declared contract.
- Unconditional exclusion of `.git`, `node_modules`, and `dist` undermines the documented caller controls for file discovery and listing. If exclusions remain, they must be explicit in the public contract; otherwise they should be removed.
- `path_exists` needs an explicit symlink decision before implementation to avoid swapping one ambiguous behavior for another.

### Decisions

- Keep `read_file` paginated, but remove the fixed hard maximum line cap from the intended contract.
- Keep `read_file` scoped to the trusted working directory only.
- Make schema-required parameters match executor-required parameters.
- Treat hidden and excluded path behavior as a contract issue, not just an implementation detail.
- Cover the final contract with focused runtime tests rather than introducing E2E coverage.

### Review Status

AR passed: no blocking architecture flaws.