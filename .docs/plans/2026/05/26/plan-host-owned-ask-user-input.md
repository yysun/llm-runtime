# Plan: Host-Owned `ask_user_input`

## Decision

Default completion should advertise `ask_user_input` to the model, but runtime facade execution must not consume package-owned user input internally. If the host supplies an executable `ask_user_input`, that executable is host code and can run through the normal tool executor. If the only available `ask_user_input` is the default contract, `runtime.complete()` should stop and return the tool call batch to the host without a human-input wait state or timeout.

This keeps two separate concerns separate:

- Model affordance: the LLM knows it may ask for required human input.
- Product control flow: the host decides how to render, wait, cancel, resume, or execute the user-input request.

## Tasks

- [x] Inspect relevant files
- [x] Make focused changes
- [x] Run validation
- [x] Update docs/status

## Implementation Notes

- Restore `ask_user_input: true` in completion defaults.
- Keep removal of runtime-owned `waiting_for_human` behavior.
- Add a neutral runtime result for host-handled tool calls instead of a HITL-specific status.
- Detect whether `ask_user_input` was host-provided through `extraTools` or `tools`; if so, executing it is host handling.
- If `ask_user_input` comes only from default built-ins, return the assistant tool-call message and tool call batch to the host.
- Keep mixed tool-call batches intact when delegating to the host so the host can return results for every tool call in the assistant message.
- Update tests to prove default visibility and host delegation.

## E2E Coverage

No separate E2E spec is needed. This is an internal TypeScript API contract and is covered by focused unit tests for model-visible tools, runtime result shape, and tool execution behavior.

## AR

AR passed: no blocking architecture flaws.

The key tradeoff is adding a generic `tool_calls` runtime status. That is cleaner than reviving `waiting_for_human`, because the runtime is not claiming to know why the host should handle the call or how it should wait. It also avoids executing part of a mixed tool-call batch and leaving the host to repair an incomplete provider protocol state.
