## Summary

- Renamed the preferred completion-loop API to `runCompletionLoop(...)` and `complete(...)` while keeping `runTurnLoop(...)` and `respondWithTools(...)` as deprecated aliases.
- Added `src/completion-loop.ts` as the preferred implementation entrypoint and converted `src/turn-loop.ts` into a compatibility re-export.
- Added `createRuntime(...)` as the preferred runtime facade and kept `createLLMEnvironment(...)` as a deprecated alias.
- Bound the runtime facade to `generate`, `stream`, `complete`, `resolveTools`, and `dispose` while preserving the old environment surface for compatibility.
- Renamed the preferred cache cleanup API to `disposeRuntimeCaches()` and kept `disposeLLMRuntimeCaches()` as a deprecated alias.
- Added deprecated `RunCompletionLoop*` preferred type names with `RunTurnLoop*` compatibility aliases.
- Restored the deprecated HITL alias `ask_user_question` and kept all HITL aliases synchronized behind `ask_user_input` guidance.
- Updated README guidance and examples so the primary path uses `createRuntime(...).complete(...)` and the advanced path uses `runCompletionLoop(...)`.
- Updated focused runtime, showcase, and completion-loop tests to exercise the preferred names while preserving alias coverage.

## Verification

- `npm run check`
- Focused llm tests passed via the test runner for:
  - `tests/llm/runtime.test.ts`
  - `tests/llm/turn-loop.test.ts`
  - `tests/llm/showcase.test.ts`
  - `tests/llm/mcp-runtime.test.ts`
  - `tests/llm/runtime-provider.test.ts`

## Notes

- No new `.docs/tests/test-runtime-api-rename.md` spec was added because this change renamed an existing public API surface rather than introducing a new end-user workflow.
- Historical/internal `.docs` and `.wiki` references to older names were left unchanged in this pass.
- `issues.md` and `rename.md` were already untracked in the worktree and were not modified.