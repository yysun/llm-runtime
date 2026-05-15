## Summary

- Split `complete(...)` evidence tracking into interaction progress and action evidence so human-input tools no longer satisfy final-text acceptance by themselves.
- Strengthened the loop prompt and HITL hint so the model is told to use safe broad read-only lookup or search before asking the user to disambiguate.
- Stopped default rejected-text retries while required interaction input is still unanswered so pending HITL turns do not re-ask the same question in plain text.
- Added a stronger post-answer recovery instruction so retries after human input explicitly tell the model to call the next task tool instead of re-asking or narrating results.
- Added a default `unsupported_evidence_claim` text classification so unsupported "I searched" or "no matching records were found" claims are rejected when no action evidence exists.
- Added public `LLMToolEvidenceKind` metadata on `LLMToolDefinition` for explicit tool evidence overrides.
- Added generic completion-loop evidence classification for interaction, control, read, write, and external-action tools.
- Updated the package-managed bound tool executor to mark evidence by tool kind instead of a coarse "tool progress" flag.
- Extended loop traces with per-tool `evidenceKind` and `countsAsActionEvidence` fields plus per-classification observed evidence flags.
- Added a reusable scripted mock LLM helper for deterministic package-managed completion-loop scenarios.
- Added a scripted Jazz Gill regression that runs through ask-user-input, a fake unsupported result claim, retry, real search tool continuation, and final text acceptance.
- Added provider-dispatch coverage proving the mocked client receives both search tools and the tightened read-only-before-HITL guidance.
- Added regressions for prompt/hint gating, unsupported evidence claims, interaction-only rejection, interaction followed by action evidence, bound executor behavior, and default custom-tool compatibility.
- Added regressions for unanswered interaction requests stopping without retry and for answered interaction requests retrying into a real task tool call.

## Verification

- `tests/llm/turn-loop.test.ts` and `tests/llm/runtime-provider.test.ts` via the test runner: 62 passing tests.
- Full unit suite via the test runner: 137 passing tests.
- `npm run check`
- `npm run build`

## Notes

- No E2E spec was added because the change is package-internal loop behavior that is deterministic under unit tests.
- Existing custom tools still count as action evidence by default unless the caller provides explicit `evidenceKind` metadata.
- `GC` was not completed because the working tree contains an unrelated untracked file, `generic-human-interaction-vs-action-evidence-fix.md`, so commit staging would be ambiguous under the workflow rules.