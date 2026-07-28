# E2E Spec: Fail-Closed Tool Approval

## Scenario: Explicit approval executes

Given a local provider returns one executable tool call
And the host approval callback returns `decision: "approve"`
When runtime completion handles the response
Then the executable tool runs exactly once
And the provider receives a second request containing the tool result
And the runtime returns `status: "completed"` with the expected final answer.

## Scenario: Explicit cancellation stops the run

Given a local provider returns one executable tool call
And the host approval callback returns
`{ decision: "cancel", reason: "rejected" }`
When runtime completion handles the response
Then the runtime returns `status: "cancelled"`
And the executable tool does not run
And the provider receives no second request.

## Scenario: Legacy and malformed approval responses cancel

Given a local provider returns one executable tool call
And the host approval callback returns either `true`, `{ approved: true }`, or
another value outside the explicit decision union
When runtime completion handles the response
Then the runtime returns `status: "cancelled"` with reason
`approval_invalid`
And the executable tool does not run
And the provider receives no second request.

## Scenario: Batch denial is atomic

Given a local provider returns two executable tool calls in one batch
And the first approval is explicit approval
And the second approval is cancellation
When runtime completion handles the response
Then the runtime returns `status: "cancelled"`
And neither executable tool runs
And the provider receives no second request.

## Scenario: Streaming cancellation has one terminal

Given a local provider returns one executable tool call
And the host approval callback cancels it
When the host consumes `streamComplete(...)`
Then exactly one `cancelled` event is emitted
And no `failed`, `tool_start`, `tool_result`, or `tool_error` event is emitted
And the executable tool does not run
And the provider receives no second request.

## Scenario: Host-owned human input remains host-owned

Given the model calls the default `ask_user_input` tool
When runtime completion handles the response
Then the runtime returns `status: "tool_calls"`
And no runtime executor, UI wait, timeout, or fabricated answer is created.
