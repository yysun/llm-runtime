# Runtime Completion Gates

## Summary

- Added explicit `completionGate.requireToolEvidence` support to runtime completion options.
- Removed the old inference that exposed mutating host tools meant the task required mutation.
- Mutation gates now reject final text and premature `final_answer` until a successful matching mutating tool result exists.
- Host-owned tool batches are now atomic: any host-owned call returns `status: "tool_calls"` with the full batch before runtime-owned tools execute.
- Unknown tools stay on the runtime error-artifact path.

## Verification

- `npm run check`
- `npx vitest run tests/llm/runtime.test.ts`
- `npm test`
- `git diff --check`

## Notes

- No `need_user_input` state or separate human-input wait state was added.
- Host resume remains the existing assistant tool-call message plus normal `role: "tool"` result messages.
