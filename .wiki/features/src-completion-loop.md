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
  - ".docs/reqs/2026/05/27/req-harden-completion-loop.md"
  - ".docs/plans/2026/05/27/plan-harden-completion-loop.md"
  - ".docs/done/2026/05/27/harden-completion-loop.md"
  - ".docs/tests/test-harden-completion-loop.md"
  - ".docs/reqs/2026/05/26/req-host-owned-ask-user-input.md"
  - ".docs/done/2026/05/26/host-owned-ask-user-input.md"
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
  - "tests/e2e/llm-turn-loop-hardening.ts"
updated_at: "2026-05-28"
---

`src/completion-loop.ts` is the part of the package that keeps the model working until there is a real result, a real blocker, or a real need for user input.

`runCompletionLoop(...)` is the lower-level implementation API. The root public examples should use the runtime facade: `complete(...)`, `streamComplete(...)`, or the methods returned by `createRuntime(...)`.

Facts from source:
- Internal callers can supply either `callModel` to own model invocation themselves or `modelRequest` to reuse package `generate(...)` and `stream(...)` through [[src-runtime]].
- `buildMessages(...)` rebuilds prompt state each iteration and can receive a transient recovery instruction when the loop decides to retry instead of stop.
- Plain-text tool intent normalization is optional through `parsePlainTextToolIntent(...)`, and `markSyntheticToolCalls` can annotate normalized tool calls on the public response surface.
- The loop applies intrinsic hard bounds for iterations and repeated identical tool-call batches. Wall-clock duration and tool-turn budgets are host policy.
- `runCompletionLoop(...)` returns structured trace data in `steps`, `toolCalls`, `classifications`, `retries`, `stop`, and `elapsedMs` in addition to the final `state`, `response`, and `reason`.
- Additive lifecycle hooks such as `onIterationStart(...)`, `onModelResponse(...)`, `onClassification(...)`, and `onStop(...)` expose deterministic trace points without taking ownership of host state.
- Standalone lower-level `complete(...)` prepends a package-owned completion-loop system prompt and is used by the runtime facade. It remains useful for internal extension and tests, but it is no longer exported from the root entrypoint.
- The package-managed `modelRequest` path defaults built-ins to all package-owned tools through `src/complete-defaults.ts`; callers use `builtIns: false` to disable them or a per-tool map to narrow the surface.
- `ask_user_input` counts as interaction progress, not task-action evidence. Final text after human input still needs later read, write, external-action, or artifact evidence when the turn requires action evidence.
- Runtime-facade completion now always uses control-tool termination. The model should call `final_answer`, `need_user_input`, or `blocked`; bare narration is retried or rejected instead of ending the run.
- The loop injects internal control tools `final_answer`, `need_user_input`, and `blocked`, intercepts them before host tool execution, and returns structured `controlOutput` metadata instead of relying on bare assistant text.
- Tool calls keep the loop alive: the runtime executes known normal tools, appends tool-result messages, and asks the model again. `generate(...)` does none of that; it returns after one provider response.
- `builtIns: false` does not disable the loop. It only removes package-owned built-ins from the model-facing surface; host tools and control tools still make completion work.
- When host tools declare mutating evidence, final completion is accepted only after a host mutating-tool result. Built-in mutating results do not satisfy that host-owned requirement.
- Terminal reasons cover both text/tool branches and deterministic stops such as `final_answer`, `needs_user_input`, `blocked`, `max_iterations_exceeded`, and `repeated_tool_call_stopped`.
- Task-duration budgets are not runtime loop guards. Hosts that need a task budget cancel with `abortSignal`.
- The structural classifier is evidence-first rather than phrase-first: unsupported tool-backed claims and post-interaction narration are rejected as non-progressing based on observed run evidence rather than English-only regex heuristics.
- The lower-level loop still leaves host policy in callbacks. If `onToolCallsResponse(...)` does not request continuation after handling tool calls, the loop stops with `tool_calls_response` by design.

Use this page for the current implementation and preferred public names. Read [[src-turn-loop]] only when you need the compatibility contract for older import paths or deprecated aliases. Related pages: [[generate-vs-complete]], [[host-owned-ask-user-input]], [[action-execution-hardening]], [[language-agnostic-continuation]], [[turn-loop-safety-and-lifecycle]], [[approval-and-synthetic-tool-call-messages]], [[src-prompt-contracts]], [[src-runtime]], and [[src-tool-validation]].
