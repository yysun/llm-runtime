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
  - ".docs/reqs/2026/05/26/req-host-owned-ask-user-input.md"
  - ".docs/done/2026/05/26/host-owned-ask-user-input.md"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-27"
---

`src/runtime-complete-contract.ts` defines the stable public result and event shapes for the runtime facade's `complete(...)` and `streamComplete(...)` helpers.

Facts from source:
- `RuntimeCompleteResult` normalizes runtime-facade completion outcomes into `completed`, `tool_calls`, `failed`, or `max_iterations`.
- `tool_calls` is the generic host-handled branch. It is used when runtime completion should surface model tool calls to the host instead of executing or waiting internally.
- `PendingHumanInput` stores the original tool call id, tool name, and structured request payload so the host can present a human question and resume later when that pattern is useful.
- `RuntimeStreamCompleteEvent` gives `streamComplete(...)` a stable event stream with `model_start`, `assistant_message`, `tool_start`, `tool_result`, `tool_error`, `tool_calls`, `completed`, `failed`, and `raw` events.
- `createHumanInputToolResult(...)` and `createAskUserInputResult(...)` turn a collected human answer back into a normal `tool` message, which lets hosts resume the same transcript without inventing a second resume protocol.

Why this matters:
- The runtime facade can keep a stable host-facing contract even though the underlying completion-loop implementation has been hardened and refactored.
- Hosts that need pause-and-resume human input do not need to reverse-engineer the tool-result message shape.
- The runtime no longer exposes a special `waiting_for_human` status or event. Human waiting, timeout, cancellation, and UI rendering are host concerns.
- Streaming harnesses can branch on event type instead of scraping mixed logs.

Read this with [[src-runtime]] for the facade that emits these results, [[host-owned-ask-user-input]] for the ownership boundary, and [[approval-and-synthetic-tool-call-messages]] for pending artifacts versus loop-generated synthetic tool calls.
