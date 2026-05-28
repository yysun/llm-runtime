---
title: "Generate vs Complete"
type: "concept"
status: "active"
language: "default"
source_paths:
  - "README.md"
  - "src/runtime.ts"
  - "src/completion-loop.ts"
  - "src/complete-defaults.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-28"
---

`generate(...)` and `complete(...)` are different ownership contracts, not just different convenience wrappers.

`generate(...)` performs one provider call. It resolves the effective tool surface and gives that schema to the provider, then returns the provider response. If the model returns tool calls, the host owns execution, message appending, retries, and the next model call.

`complete(...)` owns the bounded model/tool loop. It resolves tools, injects the loop contract, executes known non-control tools, appends tool results, and calls the model again until it reaches a terminal control path or a guardrail.

## Loop Continuation Rules

`complete(...)` keeps going when the model still owes real progress:

- A normal tool call is executed, converted into a `tool` message, and fed into the next model turn.
- Plain narration or intent text is not completion. Runtime completion continues until the model calls a control tool or hits a bound.
- Empty text can be retried according to `emptyTextRetryLimit`.
- If required action evidence is missing, final text or premature `final_answer` is rejected and the loop continues with recovery guidance.
- If the host exposes a mutating tool, final completion requires a host mutating-tool result. Package built-ins do not satisfy that host-owned evidence requirement.

`complete(...)` stops when one of the explicit terminal paths fires:

- `final_answer` returns completed output.
- `need_user_input` returns a host-visible tool-call pause so the app can ask and later resume.
- `blocked` returns a failed/blocked result.
- Repeated identical tool calls or `maxIterations` stop the loop with bounded failure metadata. Host cancellation uses `context.abortSignal`.

## Built-Ins Are Tool Surface, Not Loop Policy

`builtIns` controls only package-owned tools such as `read_file`, `write_file`, `shell_cmd`, `search_files`, and `ask_user_input`.

It does not decide whether the loop exists. `builtIns: false` with host-supplied `extraTools` or `tools` is a valid completion setup: the model still sees the host tools plus the runtime control tools (`final_answer`, `need_user_input`, `blocked`), host tools remain executable, and the loop can continue through tool results.

This boundary matters because the host may want to disable every package tool while still letting the runtime own the model/tool/control loop. The loop is the priority; built-ins are just one possible tool source.

Related pages: [[src-runtime]], [[src-completion-loop]], [[src-builtins]], [[turn-loop-safety-and-lifecycle]], and [[host-owned-ask-user-input]].
