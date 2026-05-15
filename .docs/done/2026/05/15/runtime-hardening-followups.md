## Summary

- Bounded malformed agent-control retries with repeated-tool-call and max-tool-round guards before protocol recovery continues.
- Reworked `complete(...)` evidence tracking around current-run tool progress so compacted or rebuilt histories do not depend on retained tool-message counts.
- Added a shared provider-safe tool-name translator and wired it through OpenAI-compatible, Anthropic, and Google adapters with reverse mapping to runtime names.
- Added opt-in `errorMode: 'return-artifact'` support for `executeToolCall(...)` and `executeToolCalls(...)`, while preserving default throwing behavior.
- Passed a model-request-bound `toolExecutor` into `onToolCallsResponse(...)` for package-managed completion loops and cleaned up the legacy `src/turn-loop.ts` compatibility path.
- Replaced the public runtime facade `complete(...)` and `streamComplete(...)` path with a completion-loop-backed adapter that keeps the existing runtime result and stream event contracts.
- Moved the public HITL resume helpers into `src/runtime-complete-contract.ts` and deleted the legacy `src/agentic-complete.ts` module.
- Made runtime completion strict by default for tool-driven work and added a small narration watchdog so intent-only text no longer completes the run.
- Preserved additive `stopKind` and `providerStopReason` metadata on `LLMResponse`, with OpenAI-compatible `finish_reason` mapping.
- Fixed the duplicated-word prompt typo in the managed agent loop contract.

## Verification

- Focused unit tests passed for `tests/llm/runtime.test.ts`, `tests/llm/openai-direct.test.ts`, and `tests/llm/turn-loop.test.ts`.
- `npm run build` passed.

## Notes

- No E2E spec was added because deterministic unit tests cover these package-internal loop, adapter, and tool-helper behaviors.
- Tool execution still throws by default; recoverable artifacts are opt-in for agent loops that want model-readable tool results.
- This update intentionally did not create a git commit; the workspace remains uncommitted until requested.