---
title: "Completion Loop"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "README.md"
  - ".docs/done/2026/05/15/runtime-api-rename.md"
  - ".docs/done/2026/05/15/action-evidence-separation.md"
  - ".docs/done/2026/05/15/runtime-safety-hardening.md"
  - ".docs/reqs/2026/05/14/req-natural-language-continuation.md"
  - ".docs/reqs/2026/05/15/req-action-evidence-separation.md"
  - ".docs/reqs/2026/05/15/req-runtime-safety-hardening.md"
  - ".docs/reqs/2026/05/15/req-runtime-api-rename.md"
  - ".docs/plans/2026/05/14/plan-natural-language-continuation.md"
  - ".docs/plans/2026/05/15/plan-action-evidence-separation.md"
  - ".docs/plans/2026/05/15/plan-runtime-safety-hardening.md"
  - ".docs/plans/2026/05/15/plan-runtime-api-rename.md"
  - "src/complete-defaults.ts"
  - "src/completion-loop.ts"
  - "src/index.ts"
  - "src/prompt-contracts.ts"
  - "tests/llm/showcase.test.ts"
  - "tests/llm/turn-loop.test.ts"
updated_at: "2026-05-15"
---

`src/completion-loop.ts` is the part of the package that keeps the model working until there is a real result, a real blocker, or a real need for user input.

`runCompletionLoop(...)` is the lower-level API, and `complete(...)` is the package-owned wrapper that applies the runtime's preferred defaults.

Facts from source:
- Callers can supply either `callModel` to own model invocation themselves or `modelRequest` to reuse package `generate(...)` and `stream(...)` through [[src-runtime]].
- `buildMessages(...)` rebuilds prompt state each iteration and can receive a transient recovery instruction when the loop decides to retry instead of stop.
- Plain-text tool intent normalization is optional through `parsePlainTextToolIntent(...)`, and `markSyntheticToolCalls` can annotate normalized tool calls on the public response surface.
- The loop applies intrinsic hard bounds for iterations, consecutive tool rounds, wall-clock duration, and repeated identical tool-call batches.
- `runCompletionLoop(...)` returns structured trace data in `steps`, `toolCalls`, `classifications`, `retries`, `stop`, and `elapsedMs` in addition to the final `state`, `response`, and `reason`.
- Additive lifecycle hooks such as `onIterationStart(...)`, `onModelResponse(...)`, `onClassification(...)`, and `onStop(...)` expose deterministic trace points without taking ownership of host state.
- Standalone `complete(...)` prepends a package-owned completion-loop system prompt, defaults `defaultTextResponseMode` to `permissive`, and still defaults `rejectedTextRetryLimit` to `2`, so general chat hosts can accept conversational final text while strict callers can opt into `require_tool_result`.
- The package-managed `modelRequest` path defaults built-ins to [[src-builtins]]' read-only set plus `ask_user_input` through `src/complete-defaults.ts`, so package-owned completion helpers can inspect safely before attempting side effects.
- Agent control mode is not forced globally. `complete(...)` auto-enables it only when the caller wires final-answer, needs-input, or blocked handlers, and callers can still set `agentControlMode` explicitly.
- When agent control mode is active, the runtime injects the internal control tools `final_answer`, `need_user_input`, and `blocked`, intercepts them before host tool execution, and returns structured `controlOutput` metadata instead of relying on bare assistant text.
- Terminal reasons cover both text/tool branches and deterministic stops such as `final_answer`, `needs_user_input`, `blocked`, `max_iterations_exceeded`, `max_tool_rounds_exceeded`, `timeout`, and `repeated_tool_call_stopped`.
- The structural classifier is evidence-first rather than phrase-first: unsupported tool-backed claims and post-interaction narration are rejected as non-progressing based on observed run evidence rather than English-only regex heuristics.

Use this page for the current implementation and preferred public names. Read [[src-turn-loop]] only when you need the compatibility contract for older import paths or deprecated aliases. Related pages: [[action-execution-hardening]], [[language-agnostic-continuation]], [[turn-loop-safety-and-lifecycle]], [[approval-and-synthetic-tool-call-messages]], [[src-prompt-contracts]], [[src-runtime]], and [[src-tool-validation]].