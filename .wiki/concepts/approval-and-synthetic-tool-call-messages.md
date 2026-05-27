---
title: "Approval and Synthetic Tool-Call Messages"
type: "concept"
status: "active"
language: "default"
source_paths:
  - "src/builtin-executors.ts"
  - "src/completion-loop.ts"
  - "src/turn-loop.ts"
  - "src/types.ts"
  - "src/runtime-complete-contract.ts"
  - "README.md"
  - ".docs/reqs/2026/05/26/req-host-owned-ask-user-input.md"
updated_at: "2026-05-27"
---

The runtime can add two kinds of transcript entries that may look similar at first glance but mean very different things.

In plain terms, one means "pause and ask a human what to do next," while the other means "the runtime turned narrated tool intent into a real tool-call message so the loop could keep going."

Human-input requests:
- The package-owned `ask_user_input` executor returns a `PendingHitlToolResult` with `pending: true` and `confirmed: false`. Here, HITL means "human in the loop": the product needs a real person to answer before it can continue safely.
- In default runtime completion, `ask_user_input` is model-visible but host-handled. The facade returns `status: "tool_calls"` instead of waiting internally.
- The runtime does not approve, wait, time out, or resume the request on its own.
- `src/runtime-complete-contract.ts` provides public resume helpers that turn the human answer back into a normal `tool` message for the next loop step.

Synthetic tool-call messages:
- `runTurnLoop(...)` can normalize plain text like "Calling tool: read_file" into a tool-call response when `parsePlainTextToolIntent(...)` succeeds.
- When `markSyntheticToolCalls` is enabled, the generated `LLMToolCall` and mirrored assistant `tool_calls` entries include `synthetic: true`.
- These are assistant-side tool-call messages created by the runtime, not approval artifacts.

The distinction is operational:
- Human-in-the-loop input is a host-owned pause-and-resume workflow.
- Synthetic tool calls are a loop-owned normalization step used to keep tool execution deterministic when the model narrates a tool intention instead of emitting a real call.

Read [[host-owned-ask-user-input]] for the ownership rule, [[src-builtin-executors]] for the human-input payload shape, [[src-runtime-complete-contract]] for the public resume helper, and [[src-turn-loop]] for the compatibility path around synthetic tool calls.
