# Done: Host-Owned Tool Calls

## Result

- Kept `ask_user_input` in the built-in tool catalog but removed its package executor.
- Runtime completion now treats known tools without executors as host-owned and stops with `status: "tool_calls"` instead of appending a failed tool result.
- Host-owned `ask_user_input` follows the same path as non-executable host custom tools.
- Unknown tools still fail through the existing execution artifact path.
- Hosts resume by appending normal `role: "tool"` messages and calling `complete(...)` or `streamComplete(...)` again.
- Added targeted unit coverage for callback-declined host tools, callback-handled host tools, mixed runtime/host-owned batches, and unknown tool errors.
- Added deterministic local-provider E2E coverage for default `ask_user_input`, custom non-executable host tools, and message-based resume.
- Added optional Gemini 2.5 Flash live-provider E2E coverage for the same host-owned contract.

## Validation

- `npm run check`
- `npm test`
- `npm run test:e2e:host-owned`
- `npm run test:e2e:host-owned:gemini`
