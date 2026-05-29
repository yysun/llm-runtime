# Runtime Completion Gates Plan

## Architecture Review

AR passed: no blocking architecture flaws. The runtime facade already owns host-tool policy and final-answer adaptation, so `completionGate` belongs in `LLMRuntimeCompleteOptions`. Batch atomicity belongs in `onToolCallsResponse` before parsing arguments, approval callbacks, host callbacks, or executor calls.

## Tasks

- [x] Inspect relevant files
- [x] Make focused changes
- [x] Run validation
- [x] Update docs/status

## Implementation Notes

- Replace the current implicit host-mutating-tool check with an explicit gate predicate.
- Use resolved tool definitions for mutation evidence so built-ins and custom tools are handled consistently.
- Treat successful evidence as a matching assistant tool call followed by a tool result that is not a tool-execution failure artifact.
- Classify all tool calls in a batch before executing any of them.
- Return the full assistant message in `messages` and only host-owned calls in `toolCalls` for host handling.
