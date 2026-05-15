# Architecture Plan: Runtime Safety Hardening

**Date**: 2026-05-15
**Status**: Implemented
**Requirement**: `.docs/reqs/2026/05/15/req-runtime-safety-hardening.md`

## Objective

Harden the preferred runtime API so the package defaults are safer, protocol violations are recoverable, provider-facing tool names are normalized, and tool execution is easier for hosts to consume.

## Architecture Summary

- `src/completion-loop.ts` owns the default evidence rules, loop prompt injection, and control-tool handling.
- `src/runtime.ts` owns tool resolution, runtime facade methods, and guidance injection.
- `src/builtins.ts` controls built-in exposure defaults and deprecated HITL alias behavior.
- `src/builtin-executors.ts` owns package-built tool execution and is the correct abort-propagation boundary.
- `src/tool-validation.ts` owns package-native validation and can be upgraded recursively without changing tool definitions.
- `src/openai-direct.ts` is the OpenAI-compatible boundary where provider-facing function names should be normalized and reversed.

## Design Decisions

### Loop hardening

- Keep the stricter `complete(...)` default, but make evidence run-scoped by capturing a baseline tool-result count when the loop starts.
- Treat malformed control-tool payloads as protocol violations and continue with transient recovery guidance.
- Add a `CompleteOptions` type so `complete(...)` can supply its own default `emptyTextRetryLimit`.
- Merge the runtime loop contract into the first system message using a sentinel block for idempotency.

### Built-in exposure and legacy aliases

- Change the default built-in selection mode from implicit-all to implicit read-only.
- Keep explicit `true` and `'all'` as the full opt-in path for callers that want the old behavior.
- Expose only `ask_user_input` by default and gate deprecated alias exposure behind `includeDeprecatedBuiltInAliases`.
- Allow legacy alias execution through the package-owned tool-execution helper even when aliases are not exposed to the model.

### Provider and validation hardening

- Normalize OpenAI-compatible tool names through a stable runtime-to-provider translator that enforces `[A-Za-z0-9_-]` and a 64-character cap.
- Map provider-returned tool names back to the original runtime names before surfacing package-native responses.
- Replace the shallow validator with an internal recursive validator that supports nested arrays, objects, enums, `minItems`, and nested `required` checks.

### Public execution helper

- Add top-level `executeToolCall(...)` and `executeToolCalls(...)` helpers plus bound runtime methods.
- Reuse the existing runtime tool-resolution path so built-ins, MCP tools, and extra tools stay on one execution path.

### Testing strategy

- Extend existing turn-loop, runtime, and OpenAI tests for the changed behavior.
- Add focused validation tests for nested schema enforcement.
- Cover abort behavior with targeted built-in executor tests through the public runtime surface.

### E2E decision

- No new `.docs/tests/test-runtime-safety-hardening.md` spec is needed.
- Reason: this change hardens internal runtime behavior and public API defaults rather than adding a new user-facing workflow; focused unit coverage is the correct verification layer.

## Review Notes

- Alternative considered: default `builtIns` to `false`. Rejected in favor of read-only defaults because the package still benefits from zero-write inspection tools without surprising shell or write access.
- Alternative considered: add Ajv. Rejected for this pass because the package schemas are limited enough for an internal recursive validator and the requirement favors minimality.
- Alternative considered: rename MCP tools globally at registry time. Rejected because provider compatibility is a request-encoding concern and the runtime should preserve original tool names internally.

## Tasks

- [x] Inspect relevant files
- [x] Make focused changes
- [x] Run validation
- [x] Update docs/status