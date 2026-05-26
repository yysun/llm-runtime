# Requirement: Host-Owned `ask_user_input`

## Problem

`ask_user_input` is a model-facing capability, not runtime-owned control flow.

The LLM should know that it can request user input by calling `ask_user_input` by default. But when that tool call appears, the runtime must not wait, time out, synthesize a special pause state, or execute UI behavior internally. User input belongs to the host because only the host knows how to render prompts, pause a run, collect answers, and resume.

The current split is wrong if it hides `ask_user_input` from the model by default. That removes the standard way for the model to ask for missing human decisions and pushes every host to remember to re-add the same tool contract.

## Requirement

`ask_user_input` must be advertised to the LLM by default in package-managed completion.

When the LLM emits an `ask_user_input` tool call, the runtime must treat it like a host-handled tool call:

- Surface the tool call through the normal tool-call path.
- Do not execute a package-owned user-input wait.
- Do not start or enforce a human-input timeout.
- Do not convert the call into a special `waiting_for_human` runtime result.
- Do not require `ask_user_input` to be the only tool call in a turn unless the generic tool protocol requires that for all tools.
- Let the host decide whether to pause immediately, ask the user, return a pending artifact, or continue orchestration.
- Let the host-provided tool result flow back into the message history using the normal tool-result mechanism.
- Let the next model turn consume that result naturally.

## Default Exposure

Default package-managed completion should include the `ask_user_input` tool contract in the model-visible tool set.

That default exposure is only a contract advertisement. It does not mean the runtime owns UI behavior or blocking waits.

## Host Responsibility

The host owns:

- Rendering the user-input request.
- Deciding whether the run pauses.
- Waiting for the human, if waiting is needed.
- Timing out, cancelling, or dismissing the prompt, if the product wants that.
- Returning the tool result message when an answer is available.

## Non-Goals

- Do not create a runtime-level human input scheduler.
- Do not add a runtime timeout for human responses.
- Do not preserve a runtime-specific `waiting_for_human` result as the primary contract.
- Do not make hosts manually define the standard `ask_user_input` schema just to let the model ask.

## Acceptance Criteria

- `complete()` and `runtime.complete()` expose `ask_user_input` to the LLM by default.
- Runtime code does not handle `ask_user_input` by waiting for user input.
- Runtime code does not enforce an `ask_user_input` timeout.
- Runtime code does not special-case `ask_user_input` into `waiting_for_human`.
- Host-owned handling can receive the tool call and return a normal tool result.
- Tests cover that `ask_user_input` is default-visible while runtime handling remains host-owned.
