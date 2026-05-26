# Host-Owned `ask_user_input`

## Summary

- Restored default model visibility for `ask_user_input` in package-managed completion.
- Removed runtime-owned human-input control flow from the facade path: no wait, no human-input timeout, no `waiting_for_human` status.
- Added a generic `tool_calls` runtime result/event so default `ask_user_input` calls can be handed to the host without pretending the runtime owns the UI decision.
- Kept host executables first-class: if the host supplies an executable `ask_user_input`, runtime completion executes that host tool like any other tool.
- Updated docs and tests around the host-owned contract.

## Verification

- `npm test`
- `npm run check`
- `git diff --check`
- CR passed: no major flaws found.
- VR passed: the requirement acceptance criteria are implemented and covered by unit tests.

## Notes

- No E2E spec was added; this is an internal TypeScript API contract covered by focused unit tests.
- `ask_user_input` remains a reserved built-in contract, but host-provided definitions with that name are allowed so products can own the actual interaction.
