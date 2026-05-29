# Copilot Pattern Runtime

## Summary

- Reframed runtime completion as a Copilot-style split: mechanical loop state plus preferred semantic `final_answer`.
- Kept `ask_user_input` host-owned: it remains model-visible, has no package executor, and returns as `tool_calls` for host handling.
- Updated managed prompt wording so `final_answer` is preferred, not the only valid completion path.
- Added buffered and streaming regressions that reject plain final text immediately after a resumed `ask_user_input` answer until action evidence exists.

## Verification

- `npx vitest run tests/llm/runtime.test.ts`
- `npm run check`
- `npm run build`
- `npm test`
- `git diff --check`
- CR passed: no blocking issues found in the host-owned tool boundary or completion semantics.

## Notes

- No CLI-specific or Agent World-specific logic was added.
- Existing host-owned tool tests still assert `ask_user_input.execute` is `undefined`.
