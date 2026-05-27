# Codex CLI Instructions: Harden `llm-runtime` Completion Loop

Repository: `yysun/llm-runtime`

You are working on the `llm-runtime` package. Implement the following three changes in order: **P0 streaming**, **P1 control-tool termination**, and **P2 lower-level loop contract cleanup**.

Do not rewrite the architecture. Keep the existing `completion-loop.ts` as the canonical loop, keep `turn-loop.ts` as a compatibility re-export, and preserve the public API unless explicitly extended below.

---

## Context

The runtime already has a mostly correct interleaved model/tool loop:

- `src/completion-loop.ts` owns `runCompletionLoop(...)` and `complete(...)`.
- `src/runtime.ts` exposes `createRuntime(...)`, `runtime.complete(...)`, and `runtime.streamComplete(...)`.
- Provider adapters normalize responses into `LLMResponse`.
- `ask_user_input` is host-owned by default when the host does not provide an executable override.
- Repeated tool calls, empty text, timeouts, and max iterations already have guards.

The remaining issues are:

1. `runtime.streamComplete()` is an async event wrapper around completion, but it does not truly stream provider text deltas.
2. Agentic task completion still depends too much on plain assistant text unless the caller manually enables agent-control handlers.
3. `runCompletionLoop(...)` advertises a `toolExecutor` parameter in `onToolCallsResponse`, but the generic loop does not actually pass it.

---

# P0 — Make `runtime.streamComplete()` Truly Stream Text Deltas

## Goal

`runtime.streamComplete()` should emit real model text deltas while still using the same hardened completion loop as `runtime.complete()`.

Currently, `streamComplete()` emits high-level events such as:

- `model_start`
- `assistant_message`
- `tool_start`
- `tool_result`
- `completed`
- `failed`

But it does not pass `mode: 'stream'` into the completion loop, and it does not wire provider `onChunk` to the public `text_delta` event.

## Required Behavior

When `runtime.streamComplete(request)` is called:

1. The runtime must call providers through the streaming path.
2. Provider text chunks must emit:

```ts
{ type: 'text_delta', delta: chunk.content, iteration }
```

3. Reasoning chunks may be ignored for now unless the existing public contract is extended. Do not leak hidden/private reasoning into public events.
4. Warnings should continue to work as before.
5. Tool calls must still be executed by the loop.
6. Final `completed`, `failed`, or `tool_calls` events must still be emitted.
7. `runtime.complete()` must remain buffered and must not emit deltas.

## Suggested Implementation

Add an internal option to `runRuntimeCompletion(...)`, for example:

```ts
type RuntimeCompletionRunMode = 'buffered' | 'stream';
```

or pass an explicit boolean:

```ts
streamModel?: boolean;
```

Then make `buildRuntimeCompletionModelRequest(...)` or the call site include:

```ts
mode: 'stream',
onChunk: (chunk) => {
  if (chunk.content) {
    emitEvent?.({
      type: 'text_delta',
      delta: chunk.content,
      iteration: currentIteration,
    });
  }
}
```

The hard part is `iteration`. Do not guess globally. Track the active iteration using `onIterationStart`.

One acceptable pattern:

```ts
let activeIteration = 0;

onIterationStart: async ({ iteration }) => {
  activeIteration = iteration;
  await emitEvent?.({ type: 'model_start', iteration });
}
```

Then the stream `onChunk` callback can use `activeIteration`.

Be careful: `onChunk` is part of `modelRequest`, while `onIterationStart` runs during the loop. This is okay as long as `activeIteration` is updated before each model call.

## Tests to Add

Add tests in `tests/llm/runtime.test.ts` or a focused stream-completion test file.

### Test 1 — emits text deltas

Mock the provider streaming path and assert that `runtime.streamComplete(...)` emits:

```ts
{ type: 'model_start', iteration: 1 }
{ type: 'text_delta', delta: 'hel', iteration: 1 }
{ type: 'text_delta', delta: 'lo', iteration: 1 }
{ type: 'assistant_message', ... }
{ type: 'completed', ... }
```

### Test 2 — streams across tool loop

Mock this sequence:

1. Model streams/returns a tool call.
2. Runtime executes tool.
3. Model streams final text deltas.
4. Runtime emits completed.

Assert that:

- `tool_start` and `tool_result` are emitted.
- final answer text deltas are emitted on the second iteration.
- `completed.result.output` contains the final full text.

## Acceptance Criteria

- `runtime.streamComplete()` uses provider streaming path.
- `text_delta` events are emitted.
- Tool execution still works.
- `runtime.complete()` behavior is unchanged.
- Existing tests pass.
- New streaming tests pass.

---

# P1 — Add Language-Independent Control-Tool Termination Mode

## Goal

Do not solve unfinished narration with English regexes.

The runtime should support a **language-independent task mode** where plain assistant text is not considered a valid terminal answer. The model must end the run through explicit control tools.

The completion loop already has control tools:

- `final_answer`
- `need_user_input`
- `blocked`

Use those structurally instead of detecting English phrases like “I will...” or “Let me...”.

## Required Behavior

Add a runtime-level option:

```ts
terminationMode?: 'text' | 'control_tools';
```

or:

```ts
agentControlMode?: boolean;
```

Prefer `terminationMode` because it explains the behavior better.

Recommended contract:

```ts
terminationMode?: 'text' | 'control_tools';
```

Behavior:

| Mode | Meaning |
|---|---|
| `text` | Plain assistant text may complete the run after existing evidence rules. |
| `control_tools` | Plain assistant text is non-progressing. The run may only end via `final_answer`, `need_user_input`, `blocked`, host-owned tool calls, or runtime failure. |

Default for now:

```ts
terminationMode: 'text'
```

Do not silently break existing consumers.

Agent World / CLI can opt into:

```ts
terminationMode: 'control_tools'
```

## Runtime Result Mapping

When `terminationMode: 'control_tools'`, wire the existing `complete(...)` control handlers and map results into `RuntimeCompleteResult`.

### `final_answer`

Return:

```ts
{
  status: 'completed',
  messages,
  output: controlOutput.answer,
  raw
}
```

Append an assistant message containing the final answer, unless the loop already gives you a better canonical assistant message.

### `need_user_input`

Do not invent a blocking waiter.

Either:

1. Return `status: 'tool_calls'` with a host-owned tool call equivalent, or
2. Extend `RuntimeCompleteStatus` with `needs_input`.

Prefer option 1 if you want minimal API change. Prefer option 2 if you want clearer semantics.

If using option 1, make sure the host can render the question.

### `blocked`

Prefer extending status:

```ts
RuntimeCompleteStatus = 'completed' | 'tool_calls' | 'failed' | 'max_iterations' | 'blocked'
```

or map to:

```ts
status: 'failed',
error: controlOutput.reason
```

Minimal-change approach: map to `failed`.

## Important Rule

In `control_tools` mode, assistant text should not terminate the run.

If the model says any of the following, in any language, it must continue or eventually fail through retry limits:

```txt
I will inspect the file.
我先看一下。
確認します。
Let me check.
```

Do not detect these strings. The rule is structural:

```txt
plain assistant text is not a terminal action in control_tools mode
```

The existing loop already classifies plain text as `non_progressing` when `agentControlMode` is true. Reuse that behavior instead of adding language-specific heuristics.

## Prompt / Tool Setup

When `terminationMode: 'control_tools'`:

1. Add the agent-control tools to the model request.
2. Include the existing agent run-loop system prompt.
3. Make it explicit that the model must call:
   - a real task tool,
   - `final_answer`,
   - `need_user_input`, or
   - `blocked`.

Do not rely on natural-language final answers.

## Tests to Add

### Test 1 — plain text does not complete in control mode

Mock model responses:

1. text: `"我先看一下。"`
2. tool call: `read_file`
3. control tool: `final_answer({ answer: "完成了" })`

Assert:

- first text is rejected/retried as non-progressing.
- runtime continues.
- final result is `completed` with output `"完成了"`.

### Test 2 — final_answer completes

Mock a direct `final_answer` tool call.

Assert:

- runtime returns `status: 'completed'`
- output is the answer
- no tool execution is attempted for `final_answer`

### Test 3 — blocked stops

Mock `blocked({ reason: "Missing permission." })`.

Assert:

- runtime returns failed or blocked according to chosen contract.
- error/reason is preserved.

### Test 4 — need_user_input stops for host

Mock `need_user_input({ question, reason })`.

Assert:

- runtime returns a host-actionable result.
- the question is available to the caller.
- the loop does not continue forever.

## Acceptance Criteria

- No English regex or language-specific unfinished narration detection.
- `terminationMode: 'control_tools'` exists on runtime completion options.
- Control tools are added only when control mode is enabled.
- Plain assistant text cannot terminate control mode.
- Existing text-mode behavior remains compatible.
- Tests cover non-English unfinished narration.

---

# P2 — Fix `runCompletionLoop(...)` Tool Executor Contract

## Goal

The generic lower-level `runCompletionLoop(...)` type says `onToolCallsResponse` may receive `toolExecutor`, but the actual generic loop does not pass it. The wrapper `complete(...)` compensates, but the lower-level contract is misleading.

Fix the contract.

## Preferred Fix

Make `runCompletionLoop(...)` pass a package-managed `toolExecutor` when `modelRequest` is provided.

Current type already allows:

```ts
onToolCallsResponse: (params: {
  state: TState;
  response: LLMResponse;
  messages: TMessage[];
  iteration: number;
  toolExecutor?: TurnLoopToolExecutor;
}) => Promise<TurnLoopStepResult<TState> | void>;
```

But the actual call site omits `toolExecutor`.

Implement:

1. In `runCompletionLoop(...)`, create a `toolExecutor` when `options.modelRequest` exists.
2. Pass it into `onToolCallsResponse`.
3. Preserve the `complete(...)` wrapper’s evidence tracking. Avoid double-counting evidence.

## Important Detail

There are currently two evidence-tracking layers:

1. `runCompletionLoop(...)` local variables:
   - `observedInteractionProgress`
   - `observedActionEvidence`

2. `complete(...)` wrapper local variables:
   - also tracks observed evidence so default text classification can work even when message history is compacted.

Do not break the wrapper’s run-scoped evidence behavior.

If moving tool executor creation into `runCompletionLoop(...)` risks double-counting or changes behavior too much, use the fallback fix below.

## Fallback Fix

If passing a real executor from `runCompletionLoop(...)` is too invasive, remove `toolExecutor` from the generic `RunCompletionLoopOptions.onToolCallsResponse` callback type and keep it only in the higher-level `complete(...)` callback.

This is less useful but honest.

Preferred outcome remains: lower-level `runCompletionLoop(...)` provides the executor when it can.

## Tests to Add

### Test 1 — generic loop receives toolExecutor with modelRequest

Use `runCompletionLoop(...)` with `modelRequest` and a mock tool.

Assert that `onToolCallsResponse` receives a defined `toolExecutor`.

### Test 2 — generic loop can execute tool through provided executor

Inside `onToolCallsResponse`, call:

```ts
await toolExecutor.executeToolCall(...)
```

Append the tool result message and continue.

Assert the loop reaches final text.

### Test 3 — no executor without modelRequest

Use custom `callModel` without `modelRequest`.

Assert `toolExecutor` is undefined.

## Acceptance Criteria

- The TypeScript contract matches runtime behavior.
- Existing `complete(...)` behavior remains unchanged.
- Tool evidence classification still works.
- No duplicate tool execution.
- Existing tests pass.

---

# Global Constraints

Follow these constraints while implementing all three priorities:

1. Keep `src/completion-loop.ts` as the canonical loop.
2. Keep `src/turn-loop.ts` as a compatibility re-export.
3. Do not reintroduce deleted legacy loop implementations.
4. Do not add English-only unfinished narration checks.
5. Preserve `ask_user_input` as host-owned by default when no executable override exists.
6. Preserve provider stop metadata:
   - `stopKind`
   - `providerStopReason`
7. Do not leak hidden/private reasoning through `streamComplete()` events.
8. Keep `runtime.complete()` backwards-compatible unless the caller opts into the new termination mode.
9. Add tests before or alongside implementation.
10. Run the full check suite.

---

# Commands to Run

Run these before finishing:

```bash
npm run check
npm test
```

Also run targeted tests while developing:

```bash
npx vitest run tests/llm/runtime.test.ts
npx vitest run tests/llm/turn-loop.test.ts
```

If you add a new stream-specific test file, run it directly too.

---

# Expected Final Summary

When finished, report:

1. Files changed.
2. New public API options added.
3. Tests added.
4. Whether `runtime.complete()` remains backward-compatible.
5. Whether `runtime.streamComplete()` now emits `text_delta`.
6. Any intentional tradeoffs or skipped items.
