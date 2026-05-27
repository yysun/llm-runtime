# Harden Completion Loop

## Requirement

The runtime must tighten the completion loop without replacing its architecture. `src/completion-loop.ts` remains the canonical loop, `src/turn-loop.ts` remains a compatibility re-export, and current `runtime.complete()` callers must keep working unless they opt into new behavior.

## P0 Streaming

- `runtime.streamComplete(request)` must use the provider streaming path.
- Provider text chunks must emit public `text_delta` events with the active loop iteration.
- Hidden or private reasoning chunks must not be exposed through public stream events.
- Existing stream lifecycle events must remain: `model_start`, `assistant_message`, `tool_start`, `tool_result`, `completed`, `failed`, and `tool_calls`.
- Tool execution must continue to run through the hardened loop.
- `runtime.complete()` must stay buffered and must not emit text deltas.

## P1 Control-Tool Termination

- Runtime completion options must expose `terminationMode?: 'text' | 'control_tools'`.
- The default must be `text` for compatibility.
- In `control_tools` mode, plain assistant text is non-progressing and cannot terminate the run.
- In `control_tools` mode, the model must have access to `final_answer`, `need_user_input`, and `blocked` control tools plus the agent run-loop prompt.
- `final_answer` must complete with the supplied answer.
- `need_user_input` must stop in a host-actionable way without spinning.
- `blocked` must stop and preserve the reason.
- The implementation must not add English-only or language-specific unfinished narration checks.

## P2 Lower-Level Loop Contract

- `runCompletionLoop(...)` must make its `onToolCallsResponse(..., toolExecutor)` type honest.
- When `modelRequest` is present, the generic loop must pass a package-managed `toolExecutor`.
- When only a custom `callModel` is present, `toolExecutor` must remain undefined.
- The higher-level `complete(...)` wrapper must preserve its run-scoped evidence tracking.
- Tool calls must not be double-executed and tool evidence must not be double-counted.

## Acceptance

- New tests cover streaming deltas, streaming through a tool loop, control-tool termination, non-English plain text rejection in control mode, and generic-loop tool executor availability.
- `npm run check`, `npm test`, `npx vitest run tests/llm/runtime.test.ts`, and `npx vitest run tests/llm/turn-loop.test.ts` pass.
