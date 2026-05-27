# Harden Completion Loop Done

## Summary

- `runtime.streamComplete()` now uses the provider streaming path and emits public `text_delta` events from provider text chunks.
- Added `terminationMode?: 'text' | 'control_tools'`; default `text` keeps existing callers compatible.
- Honored runtime-facade `agentControlMode: true` as a compatibility alias for control-tool termination.
- `control_tools` mode wires control tools and maps `final_answer`, `need_user_input`, and `blocked` into runtime results.
- Added regression coverage for post-tool “Next, I will...” narration so action evidence does not terminate control mode.
- Added a structural mutation-evidence gate so success text or `final_answer` cannot complete before an exposed write/external-action/artifact tool actually returns a result.
- `runCompletionLoop(...)` now passes a package-managed `toolExecutor` when `modelRequest` is available.
- The higher-level `complete(...)` evidence behavior remains run-scoped and compatible.

## Verification

- `npm run check`
- `npx vitest run tests/llm/runtime.test.ts`
- `npx vitest run tests/llm/turn-loop.test.ts`
- `npm test`

## Notes

- `need_user_input` maps to existing `tool_calls` status to avoid expanding the public status union.
- `blocked` maps to `failed` with the blocked reason preserved.
- Hidden reasoning chunks are intentionally ignored by `streamComplete()`.
