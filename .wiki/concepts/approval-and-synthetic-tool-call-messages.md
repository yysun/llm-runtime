---
title: "Approval and Synthetic Tool-Call Messages"
type: "concept"
status: "active"
source_paths:
  - "src/builtin-executors.ts"
  - "src/completion-loop.ts"
  - "src/turn-loop.ts"
  - "src/types.ts"
  - "src/runtime-complete-contract.ts"
  - "README.md"
updated_at: "2026-04-12"
---

The runtime can add two kinds of transcript entries that may look similar at first glance but mean very different things.

In plain terms, one means "pause and ask a human what to do next," while the other means "the runtime turned narrated tool intent into a real tool-call message so the loop could keep going."

Approval requests:
- `ask_user_input` returns a `PendingHitlToolResult` with `pending: true` and `confirmed: false`. Here, HITL means "human in the loop": the runtime needs a real person to answer before it can continue.
- This is a tool result artifact asking the harness to involve a human.
- The runtime does not approve or resume the request on its own.
- `src/runtime-complete-contract.ts` provides the public resume helper that turns the human answer back into a normal `tool` message for the next loop step.

Synthetic tool-call messages:
- `runTurnLoop(...)` can normalize plain text like "Calling tool: read_file" into a tool-call response when `parsePlainTextToolIntent(...)` succeeds.
- When `markSyntheticToolCalls` is enabled, the generated `LLMToolCall` and mirrored assistant `tool_calls` entries include `synthetic: true`.
- These are assistant-side tool-call messages created by the runtime, not approval artifacts.

The distinction is operational:
- Human-in-the-loop approval is a host-owned pause-and-resume workflow.
- Synthetic tool calls are a loop-owned normalization step used to keep tool execution deterministic when the model narrates a tool intention instead of emitting a real call.

Read [[src-builtin-executors]] for the human-input payload shape, [[src-runtime-complete-contract]] for the public resume helper, and [[src-turn-loop]] for the compatibility path around synthetic tool calls.