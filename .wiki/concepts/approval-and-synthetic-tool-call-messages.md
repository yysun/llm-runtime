---
title: "Approval and Synthetic Tool-Call Messages"
type: "concept"
status: "active"
source_paths:
  - "src/builtin-executors.ts"
  - "src/turn-loop.ts"
  - "src/types.ts"
  - "README.md"
updated_at: "2026-04-12"
---

The runtime has two different message shapes that can look similar in a transcript but mean different things.

Approval requests:
- `human_intervention_request` returns a `PendingHitlToolResult` with `pending: true` and `confirmed: false`.
- This is a tool result artifact asking the harness to involve a human.
- The runtime does not approve or resume the request on its own.

Synthetic tool-call messages:
- `runTurnLoop(...)` can normalize plain text like "Calling tool: read_file" into a tool-call response when `parsePlainTextToolIntent(...)` succeeds.
- When `markSyntheticToolCalls` is enabled, the generated `LLMToolCall` and mirrored assistant `tool_calls` entries include `synthetic: true`.
- These are assistant-side tool-call messages created by the runtime, not approval artifacts.

The distinction is operational:
- HITL approval is a host-owned pause-and-resume workflow.
- Synthetic tool calls are a loop-owned normalization step used to keep tool execution deterministic when the model narrates a tool intention instead of emitting a real call.

Read [[src-builtin-executors]] for the HITL payload shape and [[src-turn-loop]] for the normalization path and stop metadata around synthetic tool calls.