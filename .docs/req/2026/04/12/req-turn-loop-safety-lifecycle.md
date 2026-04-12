# Requirement: Turn Loop Safety And Lifecycle

**Date**: 2026-04-12
**Type**: Runtime Reliability / API Surface
**Status**: Completed

## Overview

Strengthen `llm-runtime` so `runTurnLoop(...)` has intrinsic loop-safety bounds, explicit stop semantics, richer observability, and a public cleanup surface for environment-owned and convenience-path resources.

This requirement exists because the current runtime exposes generic iterative orchestration but still leaves several safety and lifecycle concerns either unbounded or caller-owned in ad hoc ways. In particular, package consumers should not need to add their own outer loop guard just to prevent runaway tool rounds, and they should not need test-only helpers to release cached runtime resources.

## Problem Statement

The current runtime has useful response classification and retry behavior, but it still has important gaps:

- `runTurnLoop(...)` has no built-in hard limit for total iterations
- `runTurnLoop(...)` has no built-in hard limit for consecutive tool rounds
- `runTurnLoop(...)` has no wall-clock timeout owned by the loop itself
- repeated identical tool-call patterns are not detected and stopped
- terminal reasons do not distinguish loop exhaustion, timeout, or repeated-call suppression
- the public result type does not retain enough execution history for debugging or tracing
- there are no lifecycle hooks for iteration start, model response, classification, or final stop
- synthetic plain-text-to-tool normalization is not clearly marked in the response surface
- the convenience runtime path caches MCP resources without a public cleanup API
- built-in tool ownership is documented, but the minimal-core vs optional-ops boundary is not yet explicit enough

This creates four classes of risk:

- runaway or wasteful tool loops
- weak observability when a loop stops unexpectedly
- unclear transcript semantics for synthetic tool calls
- resource leakage or stale connections for callers using cached runtime helpers

## Goals

- Make `runTurnLoop(...)` intrinsically safe against unbounded iteration, unbounded tool rounds, and excessive wall time.
- Make terminal stop semantics explicit and machine-readable.
- Expose enough structured execution history for harness debugging, metrics, and trace export.
- Add package-owned lifecycle hooks without taking ownership of harness persistence.
- Clearly distinguish synthetic tool calls from model-emitted tool calls when normalization is enabled.
- Provide a public cleanup surface for cached runtime resources and explicit environments.
- Clarify the built-in tool boundary between minimal runtime core and optional operational capabilities.
- Add regression coverage for loop safety and observability guarantees.
- Tighten docs so callers understand exactly what the runtime owns and what the harness still owns.

## Non-Goals

- Replacing the current callback-driven host-owned state model.
- Moving tool execution policy, transcript persistence, or retry-state persistence into the runtime.
- Adding provider-specific orchestration logic to direct provider modules.
- Redesigning the full tool catalog in this requirement beyond clarifying package ownership and optional layering.
- Guaranteeing that every weak model behaves optimally through prompting alone.

## Functional Requirements

### Loop Safety Limits

- **REQ-1**: `runTurnLoop(...)` must support a hard `maxIterations` limit.
- **REQ-2**: The runtime must stop before executing beyond the configured maximum iteration count.
- **REQ-3**: `runTurnLoop(...)` must support a hard `maxConsecutiveToolTurns` limit.
- **REQ-4**: The runtime must count consecutive tool-response iterations and stop once the configured bound is reached.
- **REQ-5**: `runTurnLoop(...)` must support a hard `maxWallTimeMs` limit for the overall loop.
- **REQ-6**: The runtime must stop when the elapsed wall-clock time for the loop reaches the configured bound, even if the loop would otherwise continue.
- **REQ-7**: The loop must detect repeated same-tool-call patterns and stop when the configured repeated-call guard determines the loop is cycling without progress.
- **REQ-8**: Repeated-call detection must be deterministic and based on tool-call identity data available to the runtime, not on inferred semantic intent.
- **REQ-9**: Loop-safety behavior must apply equally to package-managed model invocation and caller-supplied `callModel(...)`.

### Explicit Stop Reasons

- **REQ-10**: Terminal loop results must expose explicit stop reasons for hard iteration exhaustion.
- **REQ-11**: Terminal loop results must expose explicit stop reasons for hard consecutive tool-round exhaustion.
- **REQ-12**: Terminal loop results must expose an explicit stop reason for wall-clock timeout.
- **REQ-13**: Terminal loop results must expose an explicit stop reason when repeated same-tool-call suppression stops the loop.
- **REQ-14**: Existing stop reasons for ordinary successful and non-successful response handling must remain distinguishable from the new hard-stop reasons.
- **REQ-15**: Stop reasons must be stable string literals suitable for programmatic branching by harness code.

### Result Surface And Traceability

- **REQ-16**: `RunTurnLoopResult` must include a per-step summary for every completed iteration.
- **REQ-17**: Each step summary must identify at minimum the iteration number, the response kind observed, and the branch taken by the runtime.
- **REQ-18**: `RunTurnLoopResult` must include tool-call summaries for model-emitted and runtime-normalized tool calls encountered during the loop.
- **REQ-19**: Tool-call summaries must expose enough data to distinguish repeated calls and to explain why a repeated-call guard stopped the loop.
- **REQ-20**: `RunTurnLoopResult` must include text-classification history for iterations where classification occurred.
- **REQ-21**: `RunTurnLoopResult` must include retry history sufficient to explain empty-text retries, rejected-text retries, and any other bounded retry paths owned by the loop.
- **REQ-22**: The runtime must preserve the final `state`, final `response`, and final stop reason in addition to the richer history fields.

### Lifecycle Hooks

- **REQ-23**: `runTurnLoop(...)` must expose an `onIterationStart(...)` lifecycle hook.
- **REQ-24**: `runTurnLoop(...)` must expose an `onModelResponse(...)` lifecycle hook after model invocation and before terminal branching is finalized.
- **REQ-25**: `runTurnLoop(...)` must expose an `onClassification(...)` lifecycle hook when text classification occurs.
- **REQ-26**: `runTurnLoop(...)` must expose an `onStop(...)` lifecycle hook immediately before the terminal result is returned.
- **REQ-27**: Lifecycle hooks must be additive and must not replace the existing branch callbacks that own state updates.
- **REQ-28**: Lifecycle hooks must observe the runtime’s actual ordering so callers can build deterministic traces and metrics.

### Synthetic Tool Call Marking

- **REQ-29**: When plain-text-to-tool normalization converts a text response into a tool-call response, the normalized tool call must be clearly marked as synthetic.
- **REQ-30**: The synthetic marker must be available on the public response or tool-call surface returned to the caller.
- **REQ-31**: Synthetic marking must be opt-in so existing callers do not receive changed semantics unless they enable it.
- **REQ-32**: When synthetic marking is disabled, plain-text-to-tool normalization behavior may remain otherwise unchanged.

### Cleanup And Resource Lifecycle

- **REQ-33**: The public API must expose a cleanup method for explicit environments so callers can dispose runtime-owned registries and cached resources through one package-owned boundary.
- **REQ-34**: The public API must expose a cleanup method for convenience-path cached runtime resources created without an explicit environment.
- **REQ-35**: Cleanup must close MCP registries or clients owned by the runtime and clear any associated cached tool-discovery state.
- **REQ-36**: Cleanup must be safe to call more than once.
- **REQ-37**: Cleanup behavior must be public and documented; callers must not need to depend on test-only reset helpers.

### Built-In Tool Scope

- **REQ-38**: The package must explicitly document which built-in tools belong to the minimal runtime core.
- **REQ-39**: The package must explicitly document which built-in tools are optional operational capabilities if an ops layer separation is retained or introduced.
- **REQ-40**: If the current tool set remains package-owned as one surface, the docs must still define the intended boundary so callers understand what is considered stable runtime scope versus optional convenience.
- **REQ-41**: Any clarification of built-in tool scope must preserve reserved-name guarantees and collision rules.

### Test Coverage

- **REQ-42**: Automated coverage must verify infinite loop prevention through the new hard limits.
- **REQ-43**: Automated coverage must verify repeated failed or repeated identical tool-call prevention.
- **REQ-44**: Automated coverage must verify wall-clock timeout behavior.
- **REQ-45**: Automated coverage must verify retry-bound behavior where loop-owned retry limits interact with the new hard-stop conditions.
- **REQ-46**: Automated coverage must verify lifecycle-hook firing order.
- **REQ-47**: Automated coverage must verify trace completeness for the richer result surface.
- **REQ-48**: Automated coverage must verify final stop-reason coverage for every terminal hard-stop path introduced by this requirement.

### Documentation

- **REQ-49**: Public docs must clearly describe the responsibility split between runtime and harness.
- **REQ-50**: Public docs must clearly describe what `runTurnLoop(...)` owns.
- **REQ-51**: Public docs must clearly describe what the caller still owns, including state shape, message construction, tool execution, persistence, and replay.
- **REQ-52**: Public docs must clearly describe environment and cleanup ownership so callers know when they are responsible for disposal.
- **REQ-53**: Public docs must clearly describe synthetic tool-call behavior and the opt-in nature of the synthetic marker when enabled.

## Non-Functional Requirements

- **NFR-1 (Safety)**: The runtime must fail closed on runaway-loop conditions by stopping with explicit reasons rather than silently continuing indefinitely.
- **NFR-2 (Determinism)**: Hard-stop and repeated-call detection must behave consistently for the same sequence of loop inputs.
- **NFR-3 (Observability)**: The result and hook surfaces must provide enough data for harnesses to debug why the loop stopped without requiring transcript re-derivation.
- **NFR-4 (Compatibility)**: New behavior must be additive where possible so existing callers can adopt richer hooks and trace fields incrementally.
- **NFR-5 (Resource Hygiene)**: Runtime-owned network or registry resources must be releasable through supported public APIs.

## Constraints

- `src/turn-loop.ts` remains a host-agnostic runtime loop and must not take ownership of harness persistence, queueing, or tool policy.
- Direct provider modules remain pure model invocation boundaries.
- Built-in and MCP tool execution semantics must remain deterministic under mocked and in-memory test conditions.
- Existing success and non-success response handling must remain available alongside the new hard-stop semantics.

## Acceptance Criteria

- [x] `runTurnLoop(...)` can stop with `max_iterations_exceeded` when iteration count reaches a configured hard limit.
- [x] `runTurnLoop(...)` can stop with `max_tool_rounds_exceeded` when consecutive tool rounds reach a configured hard limit.
- [x] `runTurnLoop(...)` can stop with `timeout` when the configured wall-clock budget is exhausted.
- [x] `runTurnLoop(...)` can stop with `repeated_tool_call_stopped` when repeated same-tool-call suppression is triggered.
- [x] The final result includes per-step summaries, tool-call summaries, and classification or retry history.
- [x] Lifecycle hooks fire in deterministic order and observe the actual runtime branches taken.
- [x] Plain-text-to-tool normalization can mark normalized tool calls as synthetic when the feature is enabled.
- [x] Synthetic marking remains opt-in.
- [x] Callers can dispose explicit environments through a public cleanup API.
- [x] Callers can dispose convenience-path cached runtime resources through a public cleanup API.
- [x] MCP clients and cached tool-discovery state are released by supported cleanup calls.
- [x] Automated tests cover infinite-loop prevention, repeated-call suppression, timeout behavior, retry bounds, lifecycle hook ordering, trace completeness, and stop-reason coverage.
- [x] Public docs clearly explain runtime ownership, harness ownership, and cleanup expectations.

## References

- `src/turn-loop.ts`
- `src/runtime.ts`
- `src/mcp.ts`
- `src/types.ts`
- `src/builtins.ts`
- `README.md`
- `tests/llm/turn-loop.test.ts`
- `tests/e2e/llm-turn-loop-showcase.ts`
