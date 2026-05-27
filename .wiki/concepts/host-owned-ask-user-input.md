---
title: "Host-Owned ask_user_input"
type: "concept"
status: "active"
language: "default"
source_paths:
  - "README.md"
  - ".docs/reqs/2026/05/26/req-host-owned-ask-user-input.md"
  - ".docs/done/2026/05/26/host-owned-ask-user-input.md"
  - "src/complete-defaults.ts"
  - "src/runtime.ts"
  - "src/runtime-complete-contract.ts"
  - "src/builtins.ts"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/turn-loop.test.ts"
updated_at: "2026-05-27"
---

`ask_user_input` is a model-facing contract, not a runtime-owned UI loop.

The important decision is the split: the package should tell the model how to ask for required human decisions, but the host decides how that request is shown, paused, answered, timed out, cancelled, persisted, and resumed.

Facts from source:
- `src/complete-defaults.ts` exposes `ask_user_input` by default for package-managed completion, alongside read-only workspace tools.
- `src/runtime.ts` treats default `ask_user_input` calls as host-handled when the host did not provide an executable tool with that name. The runtime facade returns `status: "tool_calls"` with the assistant message and tool-call batch.
- The runtime does not wait for human input, enforce a human-input timeout, or emit a `waiting_for_human` result.
- If the host supplies executable `ask_user_input` through `extraTools` or `tools`, runtime completion executes that host tool normally.
- Hosts resume by appending a normal `tool` message with the pending tool call id and serialized answer, then calling `complete(...)` or `streamComplete(...)` again with the updated messages.
- `src/runtime-complete-contract.ts` still contains helper functions for that message shape, but they are no longer exported from the root entrypoint.
- `ask_user_input` is an interaction tool, not task-action evidence. The loop still requires later action evidence when the turn cannot be completed from human input alone.

Why this matters:
- Hiding `ask_user_input` by default makes every host re-create the same schema just to let the model ask a human.
- Owning the wait inside the package would be worse: only the host knows the product UI, cancellation policy, timeout rules, and resume storage.

Read this with [[src-runtime]], [[src-runtime-complete-contract]], [[src-completion-loop]], and [[approval-and-synthetic-tool-call-messages]].
