---
title: "Turn Loop"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "src/index.ts"
  - "src/turn-loop.ts"
  - ".docs/reqs/2026/05/14/req-natural-language-continuation.md"
  - ".docs/plans/2026/05/14/plan-natural-language-continuation.md"
  - "tests/llm/turn-loop.test.ts"
  - "README.md"
updated_at: "2026-05-15"
---

`runTurnLoop(...)` is the lower-level host-agnostic model and tool loop. `respondWithTools(...)` is now the preferred wrapper when a caller wants package-owned defaults for tool-capable continuation.

Facts from source:
- Callers can supply either `modelRequest` to reuse package `generate(...)` / `stream(...)` or `callModel` to invoke the model themselves.
- `buildMessages(...)` rebuilds prompt state each iteration and can receive a transient recovery instruction.
- Plain-text tool intent normalization is optional through `parsePlainTextToolIntent(...)`, and `markSyntheticToolCalls` can annotate normalized tool calls on the public response surface.
- The loop now applies intrinsic hard bounds for iterations, consecutive tool rounds, wall-clock duration, and repeated identical tool-call batches.
- Text responses may be accepted, retried, or rejected based on `requiresActionEvidence(...)`, `classifyTextResponse(...)`, and the additive `defaultTextResponseMode` option.
- `RunTurnLoopResult` now includes `steps`, `toolCalls`, `classifications`, `retries`, `stop`, and `elapsedMs` in addition to the final `state`, `response`, and `reason`.
- Additive lifecycle hooks `onIterationStart(...)`, `onModelResponse(...)`, `onClassification(...)`, and `onStop(...)` expose deterministic trace points without taking ownership of host state.
- Terminal reasons now include hard-stop paths such as `max_iterations_exceeded`, `max_tool_rounds_exceeded`, `timeout`, and `repeated_tool_call_stopped`.
- `respondWithTools(...)` now defaults `defaultTextResponseMode` to `require_tool_result` and `rejectedTextRetryLimit` to `1`, so unresolved tool-capable text gets one internal recovery turn before the loop stops.
- The package-owned default is evidence-first rather than phrase-first: before any `tool` result message appears in the prompt state, unresolved plain text is rejected as `non_progressing` unless the English narration fallback matches, in which case it is labeled `intent_only_narration`.
- Once prior tool-result evidence exists, plain text can still complete normally, and hosts can always tighten or relax the default through the existing classification hooks.

April 2026 first added action-proof rejection for narration-only replies, then extended that work with intrinsic stop bounds, synthetic tool-call marking, and structured trace history. May 2026 added language-agnostic continuation defaults so tool-capable turns no longer depend on English narration patterns for safe internal retry. See [[action-execution-hardening]], [[language-agnostic-continuation]], [[turn-loop-safety-and-lifecycle]], [[approval-and-synthetic-tool-call-messages]], and [[src-tool-validation]] for the related recovery and hardening paths.