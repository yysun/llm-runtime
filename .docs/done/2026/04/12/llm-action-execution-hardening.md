# Done: LLM Action Execution Hardening

**Date**: 2026-04-12
**Requirement**: `.docs/req/2026/04/12/req-llm-action-execution-hardening.md`
**Plan**: `.docs/plans/2026/04/12/plan-llm-action-execution-hardening.md`

## Outcome

Implemented package-level hardening so `runTurnLoop(...)` no longer treats intent-only narration as successful completion when the harness still requires action evidence.

## Delivered

- Added additive turn-loop text classification and `rejected_text_response` handling in `src/turn-loop.ts`.
- Added caller-owned hardening hooks: `requiresActionEvidence(...)`, `classifyTextResponse(...)`, `onRejectedTextResponse(...)`, and rejected-text retry accounting.
- Added exported default recovery instruction helpers for narration-only, non-progressing, and validation-failure recovery.
- Replaced opaque validation error strings with durable structured validation artifacts in `src/tool-validation.ts` and `src/types.ts`.
- Added parser/helper utilities for validation artifacts so hosts can detect validation failures and prompt corrected tool calls.
- Added unit coverage for direct-turn narration rejection, continuation narration rejection, and durable validation artifacts.
- Added deterministic e2e coverage for direct narration recovery, validation-failure self-correction, and continuation narration recovery.
- Updated `README.md` to document the hardening feature, callback-based override model, and the deterministic hardening e2e runner.

## Verification

- `npm test`
- `npm run check`
- `npm run test:e2e:hardening`

## Notes

- The package exports default recovery-instruction constants, but harnesses override the effective behavior by supplying their own `transientInstruction` values through the turn-loop callback paths.
- Validation-failure retry counting remains caller-owned by design; the package now provides the structured artifacts and helper exports needed to implement bounded recovery in the host.