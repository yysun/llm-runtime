# Harden Completion Loop Plan

## Scope

Implement the three requested runtime changes in the existing loop architecture. No legacy loop resurrection, no broad API rewrite, and no language-specific narration heuristics.

## Tasks

- [x] Inspect relevant files
- [x] Make focused changes
- [x] Run validation
- [x] Update docs/status

## Phase Plan

- [x] Confirm current runtime stream path and provider mock surface.
- [x] Add public runtime `terminationMode` type while preserving the default `text` behavior.
- [x] Wire `streamComplete()` to pass `mode: 'stream'` and emit public `text_delta` only from `chunk.content`.
- [x] Track active iteration through `onIterationStart` for stream delta events.
- [x] Map control-tool loop outcomes into runtime results.
- [x] Move lower-level package-managed tool executor availability into `runCompletionLoop(...)`.
- [x] Keep `complete(...)` evidence tracking run-scoped and avoid duplicate executor evidence recording.
- [x] Add focused runtime and turn-loop tests.
- [x] Run targeted tests, typecheck, and full unit suite.

## E2E Coverage Decision

Create a contract-level E2E spec because the work changes public runtime behavior and loop termination semantics. The executable coverage should live in `tests/llm/runtime.test.ts` and `tests/llm/turn-loop.test.ts`; the markdown spec captures the public scenarios.

## Tradeoffs

- `terminationMode: 'control_tools'` should use the existing `agentControlMode` machinery rather than a second classifier.
- `need_user_input` should map to the existing host-actionable `tool_calls` result instead of adding a new status. That keeps the API smaller while still preserving the question.
- `blocked` should map to `failed` with the reason preserved. It is explicit enough without expanding status types.
