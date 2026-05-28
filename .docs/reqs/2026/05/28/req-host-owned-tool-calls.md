# Requirement: Host-Owned Tool Calls

## Problem

`complete(...)` currently blurs two different situations:

- runtime-owned tools that the package can execute autonomously
- host-owned tools that need the product host to produce a tool result

That confusion was visible in `ask_user_input`: it is meant to be a host-owned input request, but the runtime treated it as an executable built-in by returning a synthetic pending artifact. Custom tools without an executor had the inverse problem: they were known to the runtime, but the runtime treated them as broken and appended a failure artifact instead of handing the call back to the host.

## Requirements

- `ask_user_input` must remain a registered built-in tool so the model can call the shared schema by default.
- `ask_user_input` must not have a package-owned executor.
- Runtime completion must treat `ask_user_input` as host-owned.
- Runtime completion must treat known custom tools without `execute` as host-owned.
- Host-owned tool calls must stop the loop with `status: "tool_calls"` and include the assistant message plus `toolCalls`.
- Host resumes by appending normal `role: "tool"` result messages and calling `complete(...)` again.
- Runtime-owned executable tools must still execute inside the loop and continue automatically.
- Unknown tools must remain errors; a tool that is not known to the runtime is not a host-owned contract.

## Non-Goals

- Do not reintroduce `need_user_input`.
- Do not make `builtIns` control whether completion can loop.
- Do not add an internal wait state for human input.
- Do not require all hosts to use `onToolCall`; message-based pause/resume must remain valid.
