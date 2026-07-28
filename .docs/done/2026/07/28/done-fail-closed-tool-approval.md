# Done: Fail-Closed Tool Approval

## Summary

- Kept `ask_user_input` host-owned while adding validated answered/cancelled
  outcomes, dismissible prompts, and explicit single-select free-form support.
- Separated preference collection from executable authorization.
- Replaced truthy approval responses with an explicit approve-or-cancel union.
- Added terminal buffered and streaming cancellation with no model retry.
- Preflighted complete executable batches so any denial or malformed argument
  prevents partial execution.
- Bound configured approval to strict plain, deeply frozen tool-call snapshots
  while preserving the existing no-approval `onToolCall` behavior.
- Published the breaking contract as `llm-runtime` 0.7.0 with migration
  guidance.

## Verification

- `npm run check` — passed.
- `npm run build` — passed.
- `npm test` — 11 files and 198 tests passed.
- `npm run test:e2e:host-owned` — passed all local host-owned and approval
  scenarios.
- `npm_config_cache=/private/tmp/llm-runtime-npm-cache npm pack --dry-run` —
  passed for `llm-runtime@0.7.0`.
- Independent AR, CR, and VR gates passed after their findings were fixed.

## Notes

- Hosts still own UI rendering, timeout clocks, dismissal events, and raw input
  collection.
- Approval remains opt-in; omitting `onToolApproval` preserves automatic tool
  execution.
