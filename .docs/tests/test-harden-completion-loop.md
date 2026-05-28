# Harden Completion Loop Contract Scenarios

## Scenario: streamComplete emits text deltas

Given a runtime using a provider stream response that emits `"hel"` and `"lo"` chunks  
When `runtime.streamComplete(...)` runs  
Then events include `model_start`, two `text_delta` events for iteration 1, `assistant_message`, and `completed`  
And `runtime.complete(...)` remains buffered.

## Scenario: streamComplete streams across a tool loop

Given the first model iteration streams or returns a tool call  
And the runtime executes the tool  
And the second model iteration streams final text chunks  
When `runtime.streamComplete(...)` runs  
Then tool lifecycle events are emitted  
And final answer deltas use iteration 2  
And the completed result contains the full final text.

## Scenario: control_tools rejects plain text structurally

Given `terminationMode: 'control_tools'`  
And the model first responds with non-English plain text  
When the run continues  
Then the text does not terminate the run  
And the run can finish only through `final_answer`, `blocked`, host-owned tool calls, or runtime failure.

## Scenario: control tool terminal outputs

Given `terminationMode: 'control_tools'`  
When the model calls `final_answer`  
Then the runtime completes with that answer and does not execute it as a normal tool.

Given `terminationMode: 'control_tools'`  
When the model calls host-owned `ask_user_input`  
Then the runtime returns a host-actionable `tool_calls` result containing the question.

Given `terminationMode: 'control_tools'`  
When the model calls `blocked`  
Then the runtime fails with the blocked reason preserved.

## Scenario: generic loop executor contract

Given `runCompletionLoop(...)` is called with `modelRequest`  
When `onToolCallsResponse` runs  
Then it receives a defined package-managed `toolExecutor` that can execute configured tools.

Given `runCompletionLoop(...)` is called with a custom `callModel` and no `modelRequest`  
When `onToolCallsResponse` runs  
Then `toolExecutor` is undefined.
