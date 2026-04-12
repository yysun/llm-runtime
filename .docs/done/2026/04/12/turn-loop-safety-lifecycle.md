# Done: Turn Loop Safety And Lifecycle

**Date**: 2026-04-12
**Requirement**: `.docs/req/2026/04/12/req-turn-loop-safety-lifecycle.md`
**Plan**: `.docs/plans/2026/04/12/plan-turn-loop-safety-lifecycle.md`
**Status**: Completed

## Summary

Completed the turn-loop safety and lifecycle hardening work across the public runtime surface, turn-loop orchestration, cleanup APIs, tests, and package documentation.

The implementation kept the runtime-versus-harness boundary intact:

- the runtime now owns hard loop bounds, terminal stop metadata, structured trace summaries, lifecycle hooks, synthetic tool-call marking, and supported cleanup for runtime-owned resources
- the harness still owns state shape, message construction, tool execution, persistence, replay, and caller-owned registries

## Delivered

### Turn-loop safety and observability

- Added intrinsic package defaults for `maxIterations`, `maxConsecutiveToolTurns`, `maxWallTimeMs`, and repeated identical tool-call suppression.
- Added hard terminal reasons:
  - `max_iterations_exceeded`
  - `max_tool_rounds_exceeded`
  - `timeout`
  - `repeated_tool_call_stopped`
- Expanded `RunTurnLoopResult` with `elapsedMs`, `steps`, `toolCalls`, `classifications`, `retries`, and structured `stop` metadata.
- Added additive lifecycle hooks:
  - `onIterationStart(...)`
  - `onModelResponse(...)`
  - `onClassification(...)`
  - `onStop(...)`

### Synthetic tool-call marking

- Added opt-in `synthetic?: boolean` support on `LLMToolCall`.
- Added `markSyntheticToolCalls` to annotate normalized plain-text tool intents without changing default behavior for existing callers.

### Cleanup and ownership

- Added public cleanup APIs:
  - `disposeLLMEnvironment(...)`
  - `disposeLLMRuntimeCaches()`
- Exported cleanup APIs from the root package entrypoint.
- Updated runtime ownership handling so explicit-environment disposal only shuts down MCP registries created by the runtime itself.
- Preserved caller ownership for injected registries and other non-runtime resources.

### Tests and docs

- Reworked turn-loop unit coverage for hard-stop reasons, trace summaries, lifecycle ordering, repeated-call suppression, and timeout behavior.
- Replaced test-only or direct cleanup usage in unit and e2e paths with the public cleanup APIs.
- Updated `README.md` to document safety defaults, stop reasons, lifecycle hooks, cleanup ownership, synthetic tool calls, and the minimal-core versus optional built-ins boundary.

## Verification

The following commands were run during implementation and review and completed successfully:

- `npm test`
- `npm run check`
- `npm run test:e2e:hardening`
- `npm run test:e2e:turn-loop:dry-run`

## Notable review fix

Code review found one substantive ownership bug before closeout: the first cleanup implementation would also shut down caller-injected MCP registries attached to explicit environments. That was corrected before final verification, and regression coverage was added so public cleanup only disposes runtime-owned registries.

## Changed Areas

- `src/turn-loop.ts`
- `src/runtime.ts`
- `src/index.ts`
- `src/types.ts`
- `README.md`
- `tests/llm/turn-loop.test.ts`
- `tests/llm/runtime.test.ts`
- `tests/llm/mcp-runtime.test.ts`
- `tests/llm/runtime-provider.test.ts`
- `tests/llm/showcase.test.ts`
- `tests/e2e/llm-turn-loop-hardening.ts`
- `tests/e2e/llm-turn-loop-showcase.ts`
- `tests/e2e/llm-package-showcase.ts`