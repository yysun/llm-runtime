---
title: "Turn Loop"
type: "feature"
status: "active"
source_paths:
  - "src/turn-loop.ts"
  - "tests/llm/turn-loop.test.ts"
  - "README.md"
updated_at: "2026-04-12"
---

`runTurnLoop(...)` is a host-agnostic model and tool loop. The package owns repetition and response classification; the host owns state, transcript shape, tool execution, and persistence.

Facts from source:
- Callers can supply either `modelRequest` to reuse package `generate(...)` / `stream(...)` or `callModel` to invoke the model themselves.
- `buildMessages(...)` rebuilds prompt state each iteration and can receive a transient recovery instruction.
- Plain-text tool intent normalization is optional through `parsePlainTextToolIntent(...)`, and `markSyntheticToolCalls` can annotate normalized tool calls on the public response surface.
- The loop now applies intrinsic hard bounds for iterations, consecutive tool rounds, wall-clock duration, and repeated identical tool-call batches.
- Text responses may be accepted, retried, or rejected based on `requiresActionEvidence(...)` and `classifyTextResponse(...)`.
- `RunTurnLoopResult` now includes `steps`, `toolCalls`, `classifications`, `retries`, `stop`, and `elapsedMs` in addition to the final `state`, `response`, and `reason`.
- Additive lifecycle hooks `onIterationStart(...)`, `onModelResponse(...)`, `onClassification(...)`, and `onStop(...)` expose deterministic trace points without taking ownership of host state.
- Terminal reasons now include hard-stop paths such as `max_iterations_exceeded`, `max_tool_rounds_exceeded`, `timeout`, and `repeated_tool_call_stopped`.

April 2026 first added action-proof rejection for narration-only replies, then extended that work with intrinsic stop bounds, synthetic tool-call marking, and structured trace history. See [[action-execution-hardening]], [[turn-loop-safety-and-lifecycle]], [[approval-and-synthetic-tool-call-messages]], and [[src-tool-validation]] for the related recovery and hardening paths.