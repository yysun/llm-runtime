# Done: Natural Language Continuation

**Date**: 2026-05-15
**Requirement**: `.docs/reqs/2026/05/14/req-natural-language-continuation.md`
**Plan**: `.docs/plans/2026/05/14/plan-natural-language-continuation.md`

## Summary

- Hardened `respondWithTools(...)` with a package-owned completion-loop system prompt so default tool-loop behavior is no longer client-dependent.
- Changed the package-owned unresolved-text fallback to default to `non_progressing` whenever action evidence is still required.
- Raised the default rejected-text retry budget to two retries for action-dependent turns, while keeping explicit host overrides intact.
- Replaced the default recovery instructions with evidence-based wording that permits narration but rejects narration as completion.
- Preserved explicit host control for `verified_final_response`, `intent_only_narration`, and conservative `requiresActionEvidence(...)` policies.
- Documented and regression-tested the `onToolCallsResponse(...)` continuation contract so accidental stops surface as `tool_calls_response` intentionally.

## Verification

- `npm run check`
- `npm test`
- `runTests tests/llm/turn-loop.test.ts` with 21 passing tests during the scoped SS validation pass
- CR pass on the staged runtime, README, REQ, and plan changes via `git diff`

## Notes

- No E2E spec was added because this story remains deterministic package-internal turn-loop behavior.
- The repository still has an unrelated untracked `issues.md` file that was not included in the implementation changes.