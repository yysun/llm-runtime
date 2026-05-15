## Summary

- Bounded malformed agent-control retries with repeated-tool-call and max-tool-round guards before protocol recovery continues.
- Reworked `complete(...)` evidence tracking around current-run tool progress so compacted or rebuilt histories do not depend on retained tool-message counts.
- Added a shared provider-safe tool-name translator and wired it through OpenAI-compatible, Anthropic, and Google adapters with reverse mapping to runtime names.
- Added opt-in `errorMode: 'return-artifact'` support for `executeToolCall(...)` and `executeToolCalls(...)`, while preserving default throwing behavior.
- Passed a model-request-bound `toolExecutor` into `onToolCallsResponse(...)` for package-managed completion loops and cleaned up the legacy `src/turn-loop.ts` compatibility path.
- Updated README guidance for the bound executor and recoverable artifact mode.

## Verification

- Focused unit tests passed for turn-loop, runtime, provider-name helper, and OpenAI/Anthropic/Google adapter suites.
- Full `tests/llm` unit suite passed: 128 tests.
- `npm run check` passed.
- `npm run build` passed.

## Notes

- No E2E spec was added because deterministic unit tests cover these package-internal loop, adapter, and tool-helper behaviors.
- Tool execution still throws by default; recoverable artifacts are opt-in for agent loops that want model-readable tool results.