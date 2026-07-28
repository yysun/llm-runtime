# Requirement: Fail-Closed Tool Approval

## Problem

`llm-runtime` currently mixes two different human-interaction concerns. The
model-visible `ask_user_input` contract is described as an approval path even
though the runtime deliberately delegates rendering, waiting, timeout,
dismissal, answer collection, and resume behavior to the host. At the same
time, executable tool approval accepts a boolean-shaped callback result,
turns rejection into a recoverable tool failure, and approves and executes a
multi-tool batch incrementally.

This leaves approval semantics weaker than the execution boundary requires:
malformed host responses are not represented as explicit cancellation,
rejected operations can return to the model for another attempt, and an
earlier tool in a batch can execute before a later approval is rejected.

## Requirement

Keep human-interface mechanics host-owned while making approval semantics
explicit and fail-closed in `llm-runtime`.

`ask_user_input` must remain a host-owned clarification and preference tool.
Its contract must support optional free-form answers and dismissible prompts
without treating either as execution authorization. The package must provide
a typed, validated way for hosts to normalize raw human-input responses into
either an answered outcome or a cancelled outcome.

When a host configures executable tool authorization, it must use the approval
callback for the exact tool call and successfully parsed arguments. Only an
explicit valid approval decision may permit execution. Rejection, dismissal,
host-reported timeout, malformed responses, callback errors, and all other
non-approval outcomes must cancel the runtime completion without executing the
rejected batch or returning control to the model for a retry. When no approval
callback is configured, executable tools must retain the existing automatic
execution behavior.

All approval decisions for an executable tool-call batch must be collected
before any tool in that batch executes. Malformed tool-call arguments must
abort execution of the whole batch before approval is requested; they are
reported as tool validation failures so the model may correct the call without
misrepresenting fabricated arguments as approval input.

## Acceptance Criteria

- [x] Default `ask_user_input` calls remain host-owned and return
  `status: "tool_calls"` without runtime-owned UI, waiting, timeout, or
  automatic resume behavior.
- [x] The `ask_user_input` schema supports per-question opt-in free-form
  answers and describes dismissal as cancellation rather than consent.
- [x] A public human-input outcome helper validates question IDs, selection
  cardinality, option IDs, and free-form permission, returning a typed
  cancelled outcome for skipped, dismissed, timed-out, rejected, or malformed
  responses.
- [x] Executable tool approval is represented by an explicit approve-or-cancel
  decision contract; legacy truthy or malformed values cannot authorize
  execution.
- [x] Omitting the approval callback preserves automatic executable-tool
  execution; fail-closed approval semantics apply when the host configures the
  callback.
- [x] Any non-approval decision produces a terminal cancelled completion
  result and does not trigger another model call in that run.
- [x] Approval is preflighted for the complete executable tool-call batch, and
  denial of any call causes zero tools in that batch to execute.
- [x] Malformed arguments abort the executable batch before any approval
  callback or executor runs and are returned to the model as validation
  failures without partial execution.
- [x] Buffered and streaming completion expose the cancellation outcome
  consistently.
- [x] Public documentation explains the host/runtime ownership boundary,
  human-input normalization, approval cancellation, batch behavior, and the
  breaking API migration.
- [x] Package metadata signals the breaking public-contract change with the
  appropriate pre-1.0 version increment.
- [x] Unit and local E2E coverage prove explicit approval execution,
  malformed-response cancellation, denial cancellation, no retry after
  cancellation, and zero partial batch execution.

## Constraints

- Hosts retain ownership of rendering, waiting, timeout clocks, dismissal
  events, raw input collection, and execution of host-owned tools.
- A host-observed approval timeout must be returned through the callback as an
  explicit cancel decision; `llm-runtime` does not start or enforce a timer.
- `llm-runtime` must not introduce a UI framework, timer, persistence layer,
  queue, or runtime-owned interactive wait state.
- Host-owned tool batches must continue to stop before any package-owned tool
  in the same batch executes.
- Cancellation must be distinguishable from failure, blocking, completion,
  and pending host-owned tool calls.
- Approval must be bound to the exact executable tool call presented to the
  callback.

## Non-Goals

- Adding runtime-owned prompt rendering or user-session management.
- Authorizing host-owned external tools inside `llm-runtime`; their host
  remains responsible for execution policy.
- Inferring approval from option labels, free-form text, model narration, or
  truthy JavaScript values.
- Preserving the old boolean approval callback through a compatibility flag or
  fallback mode.
- Refactoring unrelated completion-loop evidence, provider, MCP, or skill
  behavior.
