---
title: "Turn Loop Safety and Lifecycle"
type: "concept"
status: "active"
source_paths:
  - ".docs/req/2026/04/12/req-turn-loop-safety-lifecycle.md"
  - ".docs/plans/2026/04/12/plan-turn-loop-safety-lifecycle.md"
  - ".docs/done/2026/04/12/turn-loop-safety-lifecycle.md"
  - "README.md"
  - "src/turn-loop.ts"
  - "src/runtime.ts"
  - "src/types.ts"
  - "tests/llm/turn-loop.test.ts"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/mcp-runtime.test.ts"
updated_at: "2026-04-12"
---

This April 2026 story turned `runTurnLoop(...)` from a bounded retry helper into a runtime-owned safety boundary with explicit lifecycle and cleanup support.

What changed at `HEAD`:
- `src/turn-loop.ts` now applies intrinsic defaults for max iterations, consecutive tool turns, wall-clock timeout, and repeated identical tool-call suppression.
- The loop result now includes trace summaries (`steps`, `toolCalls`, `classifications`, `retries`, `stop`, `elapsedMs`) plus lifecycle hooks for iteration start, model response, classification, and stop.
- `LLMToolCall.synthetic?: boolean` and `markSyntheticToolCalls` let callers distinguish normalized plain-text tool intents from model-emitted tool calls.
- `src/runtime.ts` now exports `disposeLLMEnvironment(...)` and `disposeLLMRuntimeCaches()`, with ownership-aware cleanup so caller-injected MCP registries are not shut down by the runtime.

Why it matters:
- Callers no longer need outer guards just to prevent runaway tool loops.
- Stop reasons are machine-readable and suitable for harness branching or telemetry.
- Cleanup moved from test-only helpers and direct registry shutdown calls into a supported public API.

Read [[src-turn-loop]] for loop semantics, [[src-runtime]] for cleanup ownership, and [[testing-and-showcases]] for the regression coverage added with this story.