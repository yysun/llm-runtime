# Done: HITL Evidence And Pending Input Suspension (Scoped Down)

**Date**: 2026-05-15
**Requirement**: `.docs/reqs/2026/05/15/req-hitl-evidence-pending-input.md`
**Plan**: `.docs/plans/2026/05/15/plan-hitl-evidence-pending-input.md`

## Summary

- Tightened `ask_user_input` and the legacy aliases `human_intervention_request` and `ask_user_question` in `src/builtins.ts`. Each description now tells the model to use the tool only after safe read-only inspection or lookup cannot supply the missing information, or when the next step requires approval, a user preference, or another human-only decision such as a required confirmation. The preferred `ask_user_input` description also calls out that broad safe searches must run before HITL disambiguation prompts.
- Added a matching paragraph to `README.md` so harness authors who only read the README receive the same guidance.
- Updated the source-file recent-changes block in `src/builtins.ts`.

## Scope That Was Declined

The original requirement also asked for a durable `pending_user_input` artifact, an `acknowledgedEvidence` opt-in on `onToolCallsResponse(...)`, and a dedicated completion-loop terminal for pending user input. Commit `db9380f` shipped all three. Commit `d8e6387` reverted them because:

- The existing `PendingHitlToolResult` shape (`pending: true`, `status: 'pending'`, `confirmed: false`, structured `questions[]`, `requestId`, `type`, `allowSkip`) is already distinctive enough; hosts such as `ai-workspace/src/runtime/runChatCompletion.ts:170-176` recognise pending HITL by tool name plus payload without a new terminal-reason field.
- Tool definitions already classify action versus interaction evidence via `LLMToolEvidenceKind`. The package-managed bound `toolExecutor` only records evidence on successful execution. Requiring every host to opt in with `acknowledgedEvidence: { action: true }` was a breaking ergonomic tax with no concrete bug behind it.
- Hosts already terminate the loop on pending HITL by returning `next: { control: 'stop' }` from `onToolCallsResponse(...)`. Adding a dedicated runtime terminal duplicated host logic.

The story is intentionally closed at the description-tightening half of the requirement. The declined slices can be revisited if a real consumer or concrete bug surfaces.

## Verification

- `npx vitest run` — 138 passing tests across 11 files. No regressions.
- `npm run check` — TypeScript clean.

## Notes

- No new E2E spec was added. The change is observable through existing built-in metadata expectations.
- Existing hosts that own tool execution compile and run unchanged. There is no new callback contract to adopt.
- The companion plan and requirement docs were reconciled to reflect the partial acceptance and the rationale behind the declined slices.
