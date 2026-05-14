# Requirement: Built-In Filesystem Tools

**Date**: 2026-05-14
**Type**: Runtime Tool Contract / Built-In Tool Surface
**Status**: Implemented

## Overview

Adjust the built-in tool surface so the runtime no longer exposes `grep`, and instead exposes three filesystem-oriented tools: `search_files`, `create_directory`, and `path_exists`.

This change should make the default tool set better aligned with common agent file-workflows by separating text search from general file discovery and basic filesystem mutation checks.

## Problem Statement

The current built-in tool set includes `grep`, but it does not include a direct file-search capability, a dedicated directory-creation primitive, or a lightweight path existence check.

That creates two problems:

- agents must rely on text-search semantics when they actually need file discovery semantics
- agents must use broader shell access for simple directory creation and existence checks that should be expressible as narrower built-ins

The built-in tool surface should provide the higher-level primitives directly and remove the outdated `grep` entry from the supported contract.

## Goals

- Remove `grep` from the supported built-in tool list.
- Add `search_files` as a built-in for discovering files by pattern or path-oriented query.
- Add `create_directory` as a built-in for creating directories.
- Add `path_exists` as a built-in for checking whether a file or directory exists.
- Keep the built-in tool contract, validation rules, executor wiring, and public documentation aligned.
- Cover the tool-surface change with focused automated tests.

## Non-Goals

- Expanding shell tool capabilities.
- Introducing recursive delete, move, copy, or file-write tools beyond the requested additions.
- Redesigning unrelated built-in tools or provider integrations.
- Changing user-defined tool registration outside the built-in catalog changes required for this request.

## Functional Requirements

### Built-In Tool Catalog

- **REQ-1**: The runtime must no longer advertise or register a built-in tool named `grep`.
- **REQ-2**: The runtime must advertise and register a built-in tool named `search_files`.
- **REQ-3**: The runtime must advertise and register a built-in tool named `create_directory`.
- **REQ-4**: The runtime must advertise and register a built-in tool named `path_exists`.
- **REQ-5**: The built-in tool name union and any equivalent public type surface must be updated to remove `grep` and include the three new tool names.

### Tool Semantics

- **REQ-6**: `search_files` must support file discovery rather than content matching.
- **REQ-7**: `search_files` must return results in a deterministic, human-readable format suitable for agent consumption.
- **REQ-8**: `create_directory` must create the requested directory path, including parent directories when needed.
- **REQ-9**: `create_directory` must behave safely when the target directory already exists.
- **REQ-10**: `path_exists` must report whether the requested path currently exists.
- **REQ-11**: `path_exists` must support both files and directories without requiring separate tool names.

### Validation And Wiring

- **REQ-12**: Built-in tool validation must recognize `search_files`, `create_directory`, and `path_exists` as supported built-ins.
- **REQ-13**: Built-in tool validation must reject `grep` as an unknown or unsupported built-in.
- **REQ-14**: The built-in executor registry must provide executable handlers for `search_files`, `create_directory`, and `path_exists`.
- **REQ-15**: The runtime must not retain dead executor wiring or special validation branches for `grep` after the change.

### Documentation And Compatibility

- **REQ-16**: Public documentation must describe the new built-in tools and their intended purpose.
- **REQ-17**: Public documentation and examples must no longer present `grep` as an available built-in tool.
- **REQ-18**: Any tests or examples that reference the built-in tool catalog must be updated to reflect the new supported set.

## Non-Functional Requirements

- **NFR-1 (Least Privilege)**: The new filesystem primitives should reduce the need to use general shell execution for simple file-system tasks.
- **NFR-2 (Clarity)**: Tool names and descriptions should make the distinction between file discovery and content search obvious.
- **NFR-3 (Consistency)**: Tool definitions, validation, executors, and docs must remain synchronized.
- **NFR-4 (Safety)**: Directory creation and path checks must fail clearly and predictably on invalid input.

## Constraints

- The change applies to the runtime's built-in tool surface, not to arbitrary external tools.
- Existing code paths that enumerate built-ins must remain internally consistent after `grep` is removed.
- The new tools should follow the existing response style used by other built-in executors.

## Acceptance Criteria

- [x] `grep` is removed from the built-in tool union, catalog, executor registry, and validation logic.
- [x] `search_files` is exposed as a supported built-in tool with documented file-discovery behavior.
- [x] `create_directory` is exposed as a supported built-in tool and can create nested directories safely.
- [x] `path_exists` is exposed as a supported built-in tool and reports whether the target path exists.
- [x] Runtime tests cover successful use of the three new tools.
- [x] Runtime tests or validation tests confirm that `grep` is no longer a supported built-in.
- [x] README or equivalent public docs reflect the updated built-in tool surface.

## References

- `README.md`
- `src/builtins.ts`
- `src/builtin-executors.ts`
- `src/tool-validation.ts`
- `src/types.ts`
- `tests/llm/runtime.test.ts`
- `tests/llm/showcase-config.test.ts`