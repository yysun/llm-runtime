# Requirement: File Tool Hardening

**Date**: 2026-05-18
**Type**: Runtime Tool Contract / File Tool Behavior
**Status**: Implemented

## Overview

Improve the built-in file-tool surface so `read_file`, `write_file`, `list_files`, `search_files`, `create_directory`, and `path_exists` behave consistently with their documented workspace-scoped contract.

The runtime should make these tools predictable for agent use, especially around scope boundaries, validation behavior, hidden-path handling, and path-kind reporting.

## Problem Statement

The current built-in file-tool surface exists and covers the main filesystem tasks, but several behaviors are not aligned tightly enough with the documented contract.

The current gaps create four kinds of risk:

- a tool may return data from outside the trusted workspace scope when the caller expects workspace-only behavior
- missing or malformed arguments may fail later in execution instead of through the normal validation contract
- file listing and discovery behavior may omit paths that the caller explicitly expects to inspect
- path existence checks may not reflect all filesystem states that matter to callers, such as symlink presence

The file-tool surface should present one clear and internally consistent contract so callers can rely on the structured tools instead of falling back to shell access for basic filesystem work.

## Goals

- Keep all built-in file tools aligned with the documented trusted working-directory scope.
- Make parameter requirements and executor behavior consistent across validation, runtime execution, and documentation.
- Remove the fixed hard `read_file` line cap from the intended public contract.
- Ensure listing and discovery semantics are explicit, predictable, and controllable by caller inputs.
- Ensure path existence results accurately represent relevant filesystem states.
- Add focused automated coverage for the intended file-tool contract.

## Non-Goals

- Adding new filesystem built-ins beyond the current six tools.
- Expanding into file move, copy, delete, rename, or patch semantics.
- Changing unrelated built-in tools, provider integrations, or shell execution behavior.
- Redesigning the overall runtime tool architecture outside the file-tool contract.

## Functional Requirements

### Scope And Access Boundaries

- **REQ-1**: All six built-in file tools must operate within the trusted working-directory contract described by the runtime.
- **REQ-2**: `read_file` must not return file contents from locations outside the trusted working-directory scope unless such behavior is explicitly documented as part of the public contract.
- **REQ-3**: `write_file`, `create_directory`, and `path_exists` must continue to enforce workspace-scoped path handling for all successful operations.

### Validation And Parameter Contract

- **REQ-4**: The declared parameter schema for each file tool must match the arguments required for successful execution.
- **REQ-5**: Missing required path parameters for `read_file`, `write_file`, `create_directory`, and `path_exists` must be reported through the standard tool-validation path rather than only through executor-specific fallback errors.
- **REQ-6**: Supported compatibility aliases for file-tool parameters must remain documented and consistent with runtime validation behavior.

### Listing And Search Behavior

- **REQ-7**: `list_files` must clearly honor its documented controls for hidden entries, recursion, depth limits, and result limits.
- **REQ-8**: `search_files` must clearly honor its documented controls for hidden entries, search root, pattern matching, and result limits.
- **REQ-9**: Any always-excluded directories or path classes must either be caller-controllable or explicitly documented as part of the public tool contract.
- **REQ-10**: `list_files` and `search_files` must continue to return deterministic, agent-readable results.

### Path Semantics

- **REQ-11**: `path_exists` must accurately report whether the requested filesystem path exists in a way that matches the runtime's intended path contract, including its treatment of symlinks.
- **REQ-12**: `path_exists` must continue to distinguish file, directory, missing, and non-standard path kinds where applicable.
- **REQ-13**: `read_file` pagination metadata must accurately reflect the returned content slice.
- **REQ-14**: `read_file` must not impose a fixed hard maximum line cap as part of the intended public contract.

### Documentation And Test Coverage

- **REQ-15**: Public documentation for the file-tool surface must match the implemented behavior for scope, argument requirements, hidden-path handling, and result semantics.
- **REQ-16**: Automated tests must cover the intended contract for each of the six built-in file tools.
- **REQ-17**: Automated tests must cover at least one negative or edge case for workspace scope enforcement, parameter validation, and path existence semantics.

## Non-Functional Requirements

- **NFR-1 (Safety)**: File-tool behavior must minimize accidental access outside the trusted working directory.
- **NFR-2 (Predictability)**: Similar operations should use consistent validation and result conventions across the file-tool surface.
- **NFR-3 (Clarity)**: Documentation and runtime behavior must not diverge on hidden-file behavior, scope, or required parameters.
- **NFR-4 (Agent Usability)**: Tool responses must stay deterministic and easy for an agent to interpret without shell fallback.

## Constraints

- The story applies only to the existing built-in file tools: `read_file`, `write_file`, `list_files`, `search_files`, `create_directory`, and `path_exists`.
- The runtime should preserve the current structured-tool approach instead of replacing these tools with shell-oriented behavior.
- Any contract changes should stay synchronized across schemas, validation, executor behavior, README documentation, and automated tests.

## Acceptance Criteria

- [x] `read_file` behavior is aligned with the documented trusted working-directory scope.
- [x] `read_file` no longer enforces a fixed hard line cap as part of its public contract.
- [x] Required parameter validation for the file tools matches actual executor requirements.
- [x] `list_files` and `search_files` behavior around hidden entries and excluded paths is explicit and contract-consistent.
- [x] `path_exists` behavior is defined and implemented consistently for files, directories, missing paths, and symlink-related edge cases.
- [x] Public documentation reflects the implemented file-tool contract without contradictions.
- [x] Focused automated coverage exists for all six file tools, including representative edge cases.

## References

- `README.md`
- `src/builtins.ts`
- `src/builtin-executors.ts`
- `src/tool-validation.ts`
- `src/types.ts`
- `tests/llm/runtime.test.ts`