---
title: "Turn Loop Safety and Lifecycle"
type: "concept"
status: "active"
language: "default"
source_paths:
  - ".docs/req/2026/04/12/req-turn-loop-safety-lifecycle.md"
  - ".docs/plans/2026/04/12/plan-turn-loop-safety-lifecycle.md"
  - ".docs/done/2026/04/12/turn-loop-safety-lifecycle.md"
  - "README.md"
  - "src/turn-loop.ts"
  - "src/runtime.ts"
  - "src/types.ts"
  - "src/completion-loop.ts"
  - "tests/llm/turn-loop.test.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/mcp-runtime.test.ts"
updated_at: "2026-05-27"
---

This April 2026 story turned `runTurnLoop(...)` from a bounded retry helper into a runtime-owned safety boundary with explicit lifecycle and cleanup support.

What changed at `HEAD`:
- The completion loop now applies intrinsic defaults for max iterations and repeated identical tool-call suppression. Wall-clock and tool-turn budgets are host policy and should cancel the run through `abortSignal`.
- The loop result now includes trace summaries (`steps`, `toolCalls`, `classifications`, `retries`, `stop`, `elapsedMs`) plus lifecycle hooks for iteration start, model response, classification, and stop.
- The preferred `src/completion-loop.ts` path no longer owns task-duration budgets. Completed tool messages remain in the conversation, and hosts that need an outer task SLA cancel with `abortSignal`.
- `LLMToolCall.synthetic?: boolean` and `markSyntheticToolCalls` let callers distinguish normalized plain-text tool intents from model-emitted tool calls.
- `src/runtime.ts` keeps ownership-aware cleanup internally, and explicit `LLMRuntime` objects expose `runtime.dispose()` so caller-injected MCP registries are not shut down by the runtime.

Why it matters:
- Callers no longer need outer guards just to prevent runaway tool loops.
- Stop reasons and guard branches are machine-readable and suitable for harness branching or telemetry.
- Cleanup moved from test-only helpers and direct registry shutdown calls into a supported runtime API.

Read [[src-completion-loop]] for current loop semantics, [[src-turn-loop]] for compatibility aliases, [[src-runtime]] for cleanup ownership, and [[testing-and-showcases]] for regression coverage.
