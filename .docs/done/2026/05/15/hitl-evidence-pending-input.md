## Summary

- Tightened `ask_user_input` and its legacy aliases so they no longer encourage premature clarification before safe read-only inspection or lookup.
- Extended package-owned HITL artifacts with `terminalReason: "pending_user_input"` and `suspended: true` so hosts can trust the suspension state.
- Added `pending_user_input` as a real completion-loop terminal reason and surfaced the trusted artifact on `result.pendingUserInput`.
- Added additive `acknowledgedEvidence` support on `onToolCallsResponse(...)` so host-managed tool execution must explicitly confirm action evidence.
- Stopped `complete(...)` from treating emitted tool calls alone as action evidence.
- Kept interaction progress separate from action evidence so HITL prompts still inform retry behavior without satisfying final-answer evidence.
- Let the package-managed bound `toolExecutor` auto-observe confirmed action evidence and trusted HITL pending artifacts from package-owned execution.
- Added a regression proving generic `{ "pending": true }` tool messages are not treated as trusted `pending_user_input` stops.
- Updated README guidance and callback documentation for the new pending-user-input and acknowledgment contract.

## Verification

- Focused unit suites via the test runner: `tests/llm/runtime.test.ts` and `tests/llm/turn-loop.test.ts`
- Full unit suite via the test runner: 138 passing tests
- `npm run check`
- `npm run build`

## Notes

- No new E2E spec was added because the change is deterministic package-internal behavior covered by unit tests.
- Existing hosts that own tool execution still compile unchanged, but they now need to return `acknowledgedEvidence: { action: true }` when a handled tool round should count as action evidence.
- `GC` was not run because the user asked for implementation, not a commit.