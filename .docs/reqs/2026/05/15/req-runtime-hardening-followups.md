# Requirement: Runtime Hardening Followups

**Date**: 2026-05-15
**Type**: Runtime Safety / Provider Compatibility / Tool Execution API
**Status**: Implemented

## Overview

Close the remaining runtime hardening gaps found after the latest safety pass: malformed control-tool retries must remain bounded by the same loop guards as normal tool calls, tool evidence should be robust to compacted histories, provider-facing tool-name normalization should apply consistently across providers, package-owned tool execution should be easier and safer for agent loops, and the public runtime `complete()` facade must use the hardened completion loop instead of the legacy permissive agentic loop.

## Problem Statement

The current runtime has the right overall abstractions, but several edge cases still make agent-loop behavior less reliable than intended.

Malformed agent-control tool calls can retry before repeated-tool and max-tool-round guards run. `complete(...)` uses tool-result message counts to decide whether current-run evidence exists, which is fragile when hosts compact or rebuild message history. OpenAI-compatible providers get tool-name translation, but Anthropic and Google still receive raw runtime tool names. The new `executeToolCall(...)` helper throws on recoverable tool-execution errors and still requires callers to remember the exact per-call tool surface used for the model request.

The runtime facade still exposes a second `complete()` path through `src/agentic-complete.ts`. That path treats any non-empty assistant text as terminal, so `createRuntime().complete()` can still stop on intent-only narration such as "I will inspect the files now." even though the package-managed `src/completion-loop.ts` path now rejects that behavior when configured for agentic work. The split also makes the public API misleading because the top-level exported `complete(...)` and `runtime.complete(...)` have materially different safety behavior.

Provider responses also discard normalized stop metadata such as OpenAI `finish_reason`, which limits host observability and prevents the hardened runtime path from surfacing why a response stopped without relying only on text and tool-call structure.

The runtime needs a follow-up hardening pass that makes these behaviors deterministic, recoverable, and hard to misuse without redesigning the whole package.

## Goals

- Ensure malformed agent-control retries are still subject to repeated-tool-call and max-tool-round guards.
- Make default evidence tracking robust when hosts append, truncate, summarize, compact, or rebuild messages between loop iterations.
- Share provider-facing tool-name translation across OpenAI-compatible, Anthropic, and Google adapters where provider constraints require sanitized names.
- Let agent loops receive durable tool-result artifacts for recoverable execution errors instead of always throwing.
- Make `complete(...)` expose a tool executor already bound to the same tool surface as the package-managed model request.
- Make `createRuntime().complete(...)` and `createRuntime().streamComplete(...)` use the hardened completion loop semantics instead of the legacy permissive agentic loop.
- Make runtime-facade completion strict by default for agentic work so plain narration is rejected until current-run tool evidence exists.
- Preserve normalized provider stop metadata on `LLMResponse` for hosts and loop diagnostics.

## Non-Goals

- Remove or redesign the agent-control tools.
- Replace host-owned state, persistence, or transcript policy.
- Remove throwing tool-execution behavior for library-style callers.
- Change unrelated provider request semantics such as web search, streaming chunks, or message conversion outside tool-name mapping.
- Introduce an external schema-validation or agent-orchestration dependency.
- Redesign the entire public runtime API surface beyond aligning the runtime facade with the already-preferred completion loop.

## Functional Requirements

### Loop Guard Ordering

- **REQ-1**: Malformed `final_answer`, `need_user_input`, and `blocked` control-tool calls must remain bounded by `repeatedToolCallGuard`.
- **REQ-2**: Malformed control-tool calls must remain bounded by `maxConsecutiveToolTurns`.
- **REQ-3**: A repeated malformed control-tool batch must be able to stop as `repeated_tool_call_stopped` before reaching `max_iterations_exceeded` when the repeated-call threshold is exceeded.
- **REQ-4**: A stream of malformed but changing control-tool batches must be able to stop as `max_tool_rounds_exceeded` when the max consecutive tool-turn threshold is exceeded.
- **REQ-5**: Valid terminal control-tool calls must still stop deterministically as `final_answer`, `needs_user_input`, or `blocked`.
- **REQ-6**: Protocol-violation recovery must continue to use `DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION` for malformed control-tool calls that remain eligible for retry.

### Run-Scoped Evidence

- **REQ-7**: `complete(...)` must not rely only on total `role: 'tool'` message count to decide whether current-run evidence exists.
- **REQ-8**: Evidence tracking must remain correct when a host compacts, truncates, summarizes, or rebuilds messages between loop iterations.
- **REQ-9**: New evidence from the current loop run must be distinguishable from old tool-result messages that existed before the run started.
- **REQ-10**: The default `require_tool_result` behavior must still reject unresolved plain text before current-run evidence exists.
- **REQ-11**: A final text response may still be accepted after current-run evidence exists, subject to host classification overrides and normal loop policy.

### Provider Tool-Name Translation

- **REQ-12**: Provider adapters must not send runtime tool names directly when those names can violate the target provider's function/tool-name constraints.
- **REQ-13**: Anthropic tool definitions and returned tool-use blocks must support the same runtime-name round trip that OpenAI-compatible requests support.
- **REQ-14**: Google/Gemini function declarations and returned function calls must support the same runtime-name round trip that OpenAI-compatible requests support.
- **REQ-15**: Tool-name translation must preserve execution against the original runtime tool names.
- **REQ-16**: Translation must avoid collisions after sanitization, including names that differ only by characters removed or replaced for provider compatibility.
- **REQ-17**: Translation must handle long names and names containing provider-problematic characters such as dots or other punctuation.

### Recoverable Tool Execution

- **REQ-18**: `executeToolCall(...)` must keep throwing by default for existing library-style callers.
- **REQ-19**: `executeToolCall(...)` must offer an opt-in non-throwing mode for agent loops.
- **REQ-20**: In non-throwing mode, invalid JSON arguments must return a durable error artifact instead of throwing.
- **REQ-21**: In non-throwing mode, unknown tool names must return a durable error artifact instead of throwing.
- **REQ-22**: In non-throwing mode, non-executable tool definitions must return a durable error artifact instead of throwing.
- **REQ-23**: The returned artifact must preserve enough information for the host to create a tool-result message tied to the original `tool_call_id`.
- **REQ-24**: `executeToolCalls(...)` must support the same error mode consistently across a batch of tool calls.

### Bound Tool Executor For Completion Loops

- **REQ-25**: When `complete(...)` uses the package-managed `modelRequest` path, `onToolCallsResponse(...)` must receive a tool executor bound to the same effective tool surface as that model request.
- **REQ-26**: The bound executor must preserve per-call `builtIns`, `includeDeprecatedBuiltInAliases`, `extraTools`, direct `tools`, `mcpConfig`, `skillRoots`, and `environment` behavior used to generate the model request.
- **REQ-27**: Runtime-facade `complete(...)` must bind the executor to the runtime environment in the same way it binds package-managed model invocation.
- **REQ-28**: Existing callers that ignore the new executor must continue working without changes.
- **REQ-29**: Callers must still be able to own custom tool execution entirely by using `callModel` or by ignoring the bound executor.

### Runtime Facade Delegation And Strict Defaults

- **REQ-30**: `createRuntime().complete(...)` must use the hardened completion-loop path rather than `src/agentic-complete.ts`.
- **REQ-31**: `createRuntime().streamComplete(...)` must expose the same hardened loop semantics as `createRuntime().complete(...)`.
- **REQ-32**: Runtime-facade completion with tools or package-managed workspace capabilities must default to `defaultTextResponseMode: 'require_tool_result'` unless the caller explicitly overrides that policy.
- **REQ-33**: Runtime-facade completion must reject intent-only narration such as "I will inspect the files now" when no current-run action evidence exists.
- **REQ-34**: Runtime-facade completion must still accept supported final text after current-run action evidence exists.
- **REQ-35**: Runtime-facade completion must preserve the existing public `LLMRuntimeCompleteResult` contract shape for completed, blocked, failed, max-iteration, and waiting-for-user-input outcomes.
- **REQ-36**: The public package should no longer present `runtime.complete(...)` as a weaker behavior than the top-level exported `complete(...)` for the same agentic use case.

### Provider Stop Metadata

- **REQ-37**: `LLMResponse` must expose a normalized stop-kind field that can distinguish at least natural stop, tool call, length stop, content filter, and unknown stop cases.
- **REQ-38**: `LLMResponse` must expose the raw provider stop reason when the provider returns one.
- **REQ-39**: OpenAI-compatible responses must map `finish_reason` into the normalized stop metadata.
- **REQ-40**: Stop metadata must be additive and must not change existing text, tool-call, usage, or warning behavior.

## Non-Functional Requirements

- **NFR-1 (Safety)**: Agent-loop retries and recoveries must remain bounded and deterministic.
- **NFR-2 (Recoverability)**: Recoverable tool-execution failures should be representable as model-readable tool results when the caller opts into that behavior.
- **NFR-3 (Provider Compatibility)**: Runtime tool names should work consistently across supported providers even when provider naming rules differ.
- **NFR-4 (Compatibility)**: Existing public APIs and default throwing behavior must remain source-compatible unless a caller opts into new behavior.
- **NFR-5 (Usability)**: The package-managed completion path should reduce duplicate wiring and make the correct tool surface difficult to forget.
- **NFR-6 (Minimality)**: Changes should stay focused on loop guards, evidence tracking, provider tool-name mapping, and tool-execution ergonomics.
- **NFR-7 (API Clarity)**: The main runtime facade should default to the safer completion semantics users expect from the package-level completion API.
- **NFR-8 (Observability)**: Provider stop metadata should be normalized consistently enough for host diagnostics without binding the package to provider-specific enums.

## Constraints

- Keep the package publishable and the public API explicit.
- Preserve host ownership of state, persistence, transcript compaction, and business-specific final-answer policy.
- Preserve deprecated compatibility aliases unless explicitly superseded by a future requirement.
- Follow the existing source file comment-block convention for implementation work.
- Add focused unit coverage for each behavioral gap; E2E coverage is not required unless a later plan identifies a provider-specific live regression path that unit tests cannot cover.
- Preserve the existing runtime result shape even if the internal implementation moves away from `agentic-complete.ts`.

## Acceptance Criteria

- [x] Repeated malformed control-tool calls can stop through `repeated_tool_call_stopped`.
- [x] Malformed control-tool retries can stop through `max_tool_rounds_exceeded`.
- [x] Valid `final_answer`, `need_user_input`, and `blocked` control calls still stop with their existing terminal reasons.
- [x] `complete(...)` default evidence handling remains correct when message history is compacted or rebuilt between iterations.
- [x] Old tool-result messages present before a run do not satisfy the current run's default evidence requirement.
- [x] Anthropic adapter requests use provider-safe tool names and map returned tool-use names back to runtime names.
- [x] Google/Gemini adapter requests use provider-safe function names and map returned function-call names back to runtime names.
- [x] Tool-name collision and long-name cases are covered for every adapter using translation.
- [x] `executeToolCall(...)` still throws by default for invalid JSON, unknown tools, and non-executable tools.
- [x] `executeToolCall(...)` can return durable error artifacts instead of throwing when the caller opts in.
- [x] `executeToolCalls(...)` applies the same error mode consistently across batches.
- [x] `onToolCallsResponse(...)` receives a bound executor on the package-managed `complete(...)` path.
- [x] The bound executor uses the same effective per-call tool surface as the model request.
- [x] Runtime-facade `complete(...)` binds the executor to the runtime environment.
- [x] Existing completion-loop callers compile and run without adopting the new executor.
- [x] Focused unit tests cover all new behavior.
- [x] `createRuntime().complete(...)` no longer completes on intent-only narration before current-run action evidence exists.
- [x] `createRuntime().streamComplete(...)` follows the same hardened completion-loop semantics as `createRuntime().complete(...)`.
- [x] Runtime-facade completion defaults to strict agentic text handling unless the caller opts out.
- [x] Runtime-facade completed results still return the expected public result shape after valid tool-backed execution.
- [x] `LLMResponse` exposes additive normalized stop metadata.
- [x] OpenAI-compatible provider responses populate normalized stop metadata from `finish_reason`.

## References

- `README.md`
- `src/completion-loop.ts`
- `src/runtime.ts`
- `src/types.ts`
- `src/openai-direct.ts`
- `src/anthropic-direct.ts`
- `src/google-direct.ts`
- `src/mcp.ts`
- `tests/llm/turn-loop.test.ts`
- `tests/llm/runtime.test.ts`
- `tests/llm/openai-direct.test.ts`
- `tests/llm/anthropic-direct.test.ts`
- `tests/llm/google-direct.test.ts`
- `.docs/reqs/2026/05/15/req-runtime-safety-hardening.md`