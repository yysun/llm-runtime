---
title: "Completion Loop"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "README.md"
  - ".docs/done/2026/05/15/runtime-api-rename.md"
  - ".docs/reqs/2026/05/14/req-natural-language-continuation.md"
  - ".docs/reqs/2026/05/15/req-runtime-api-rename.md"
  - ".docs/plans/2026/05/14/plan-natural-language-continuation.md"
  - ".docs/plans/2026/05/15/plan-runtime-api-rename.md"
  - "src/completion-loop.ts"
  - "src/index.ts"
  - "tests/llm/showcase.test.ts"
  - "tests/llm/turn-loop.test.ts"
updated_at: "2026-05-15"
---

`src/completion-loop.ts` is the canonical host-agnostic model and tool loop. `runCompletionLoop(...)` is the lower-level API, and `complete(...)` is the package-owned wrapper that applies the runtime's preferred defaults.

Facts from source:
- Callers can supply either `callModel` to own model invocation themselves or `modelRequest` to reuse package `generate(...)` and `stream(...)` through [[src-runtime]].
- `buildMessages(...)` rebuilds prompt state each iteration and can receive a transient recovery instruction when the loop decides to retry instead of stop.
- Plain-text tool intent normalization is optional through `parsePlainTextToolIntent(...)`, and `markSyntheticToolCalls` can annotate normalized tool calls on the public response surface.
- The loop applies intrinsic hard bounds for iterations, consecutive tool rounds, wall-clock duration, and repeated identical tool-call batches.
- `runCompletionLoop(...)` returns structured trace data in `steps`, `toolCalls`, `classifications`, `retries`, `stop`, and `elapsedMs` in addition to the final `state`, `response`, and `reason`.
- Additive lifecycle hooks such as `onIterationStart(...)`, `onModelResponse(...)`, `onClassification(...)`, and `onStop(...)` expose deterministic trace points without taking ownership of host state.
- `complete(...)` prepends a package-owned completion-loop system prompt, defaults `defaultTextResponseMode` to `require_tool_result`, and defaults `rejectedTextRetryLimit` to `2`, so unresolved tool-capable text gets two internal recovery turns before the loop stops.
- When agent control mode is active, the runtime injects the internal control tools `final_answer`, `need_user_input`, and `blocked`, intercepts them before host tool execution, and returns structured `controlOutput` metadata instead of relying on bare assistant text.
- Terminal reasons cover both text/tool branches and deterministic stops such as `final_answer`, `needs_user_input`, `blocked`, `max_iterations_exceeded`, `max_tool_rounds_exceeded`, `timeout`, and `repeated_tool_call_stopped`.
- The package-owned default is evidence-first rather than phrase-first: before any `tool` result message appears in the prompt state, unresolved plain text is rejected as `non_progressing` unless the harness overrides classification.

Use this page for the current implementation and preferred public names. Read [[src-turn-loop]] only when you need the compatibility contract for older import paths or deprecated aliases. Related pages: [[action-execution-hardening]], [[language-agnostic-continuation]], [[turn-loop-safety-and-lifecycle]], [[approval-and-synthetic-tool-call-messages]], [[src-runtime]], and [[src-tool-validation]].