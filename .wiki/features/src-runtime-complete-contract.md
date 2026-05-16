---
title: "Runtime Completion Contract"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "src/runtime-complete-contract.ts"
  - "src/runtime.ts"
  - "src/index.ts"
  - "src/types.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-15"
---

`src/runtime-complete-contract.ts` defines the stable public result and event shapes for the runtime facade's `complete(...)` and `streamComplete(...)` helpers.

Facts from source:
- `RuntimeCompleteResult` normalizes runtime-facade completion outcomes into `completed`, `waiting_for_human`, `failed`, or `max_iterations`.
- `PendingHumanInput` stores the original tool call id, tool name, and structured request payload so the host can present the pending question and resume later.
- `RuntimeStreamCompleteEvent` gives `streamComplete(...)` a stable event stream with `model_start`, `assistant_message`, `tool_start`, `tool_result`, `tool_error`, `waiting_for_human`, `completed`, `failed`, and `raw` events.
- `createHumanInputToolResult(...)` and `createAskUserInputResult(...)` turn a collected human answer back into a normal `tool` message, which lets hosts resume the same transcript without inventing a second resume protocol.

Why this matters:
- The runtime facade can keep a stable host-facing contract even though the underlying completion-loop implementation has been hardened and refactored.
- Hosts that need pause-and-resume HITL do not need to reverse-engineer the tool-result message shape.
- Streaming harnesses can branch on event type instead of scraping mixed logs.

Read this with [[src-runtime]] for the facade that emits these results and with [[approval-and-synthetic-tool-call-messages]] for the difference between HITL pause artifacts and loop-generated synthetic tool calls.