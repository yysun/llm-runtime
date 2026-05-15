# Requirement: Runtime Safety Hardening

**Date**: 2026-05-15
**Type**: Runtime Safety / API Hardening
**Status**: Implemented

## Overview

Harden the public runtime so the preferred `complete(...)` and runtime/tool APIs are safer by default, more protocol-correct, and easier to consume without custom boilerplate.

## Problem Statement

The current runtime still has several gaps that can produce unsafe or misleading behavior: old tool evidence can satisfy a new completion run, malformed control tools can terminate the loop with empty payloads, built-ins default to destructive capabilities, MCP tool names can violate OpenAI-compatible naming constraints, and the README still asks hosts to hand-roll tool execution.

The package needs a focused hardening pass that closes those gaps without changing its overall architecture.

## Goals

- Make `complete(...)` treat tool evidence as run-scoped instead of conversation-scoped.
- Reject malformed control-tool payloads and retry with protocol guidance instead of stopping.
- Change default built-in exposure to a safer read-only set and reduce default HITL alias noise.
- Normalize provider-facing tool names for OpenAI-compatible requests while preserving execution against the original runtime tool names.
- Make `complete(...)` easier to call by defaulting `emptyTextRetryLimit`.
- Merge the loop contract into the first system message instead of prepending a second system message.
- Propagate abort signals into package-owned tool execution.
- Replace shallow tool validation with recursive schema validation for nested objects and arrays.
- Add package-owned `executeToolCall(...)` helpers and update the docs to use them.

## Non-Goals

- Redesign the provider abstraction or tool registry architecture.
- Remove deprecated built-in aliases from the package entirely.
- Change unrelated provider behavior or existing MCP transport behavior.
- Add new end-user E2E flows beyond focused unit coverage for the hardening changes.

## Functional Requirements

- **REQ-1**: `complete(...)` must only treat tool evidence from the current loop run as satisfying the default evidence requirement.
- **REQ-2**: Old assistant/tool history from previous turns must not make a new unresolved plain-text answer terminal.
- **REQ-3**: Malformed `final_answer`, `need_user_input`, and `blocked` calls must not stop the loop.
- **REQ-4**: Malformed control-tool calls must retry with `DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION`.
- **REQ-5**: Omitting `builtIns` must no longer expose destructive built-ins by default.
- **REQ-6**: The default built-in set must be read-only and include only `load_skill`, `list_files`, `search_files`, `read_file`, and `path_exists`.
- **REQ-7**: `shell_cmd`, `write_file`, `create_directory`, `web_fetch`, and `ask_user_input` must require explicit opt-in.
- **REQ-8**: Deprecated HITL aliases must not be exposed to the model by default.
- **REQ-9**: Deprecated HITL aliases must remain executable for legacy transcript/tool execution paths when the canonical human-input built-in is enabled.
- **REQ-10**: OpenAI-compatible provider requests must only send function names matching provider constraints and must map returned tool calls back to the original runtime tool names.
- **REQ-11**: The public API must export a `CompleteOptions` type that makes `emptyTextRetryLimit` optional for `complete(...)` callers.
- **REQ-12**: `complete(...)` must merge the loop contract into the first system message using a stable sentinel block.
- **REQ-13**: Built-in `shell_cmd`, `web_fetch`, and `search_files` execution must honor `context.abortSignal`.
- **REQ-14**: Tool validation must recursively validate nested object and array schemas, including nested `required`, `enum`, `minItems`, and `additionalProperties` constraints used by package tools.
- **REQ-15**: The public runtime surface must expose package-owned `executeToolCall(...)` and `executeToolCalls(...)` helpers at both the top level and runtime-facade level.
- **REQ-16**: README examples must use the package-owned tool-execution helper instead of an undefined placeholder.
- **REQ-17**: Automated tests must cover the new defaults and regressions introduced by this hardening pass.

## Non-Functional Requirements

- **NFR-1 (Safety)**: The default package posture should minimize accidental shell, write, and destructive filesystem access.
- **NFR-2 (Compatibility)**: Existing explicit opt-in paths should keep working, including deprecated HITL aliases when requested or executed from legacy transcripts.
- **NFR-3 (Predictability)**: Protocol violations and validation failures should be deterministic and recoverable.
- **NFR-4 (Minimality)**: The changes should stay focused on runtime safety and public API usability, without unrelated refactors.

## Constraints

- Keep the package publishable and the public API explicit.
- Preserve the existing package style and file-comment-block convention for edited source files.
- Do not introduce a hard dependency on external validation libraries when an internal recursive validator is sufficient.

## Acceptance Criteria

- [x] `complete(...)` rejects unresolved text when only pre-existing tool results are present.
- [x] Malformed control-tool calls retry instead of terminating the loop.
- [x] The default `resolveTools()` surface is read-only and excludes deprecated HITL aliases.
- [x] OpenAI-compatible requests sanitize provider-facing tool names and map returned names back to original runtime names.
- [x] `CompleteOptions` is exported and `complete(...)` no longer requires `emptyTextRetryLimit` at call sites.
- [x] The loop contract is merged into the first system message instead of prepending a second system message.
- [x] Built-in tool abort behavior is covered for the hardened executors.
- [x] Recursive schema validation rejects invalid nested tool payloads.
- [x] Public `executeToolCall(...)` helpers work for built-ins and README examples use them.
- [x] Unit tests and TypeScript validation pass for the impacted surfaces.

## References

- `fix.md`
- `README.md`
- `src/completion-loop.ts`
- `src/runtime.ts`
- `src/builtins.ts`
- `src/builtin-executors.ts`
- `src/tool-validation.ts`
- `src/openai-direct.ts`
- `src/types.ts`
