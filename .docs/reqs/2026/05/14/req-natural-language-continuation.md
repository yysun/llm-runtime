# Requirement: Natural Language Continuation

**Date**: 2026-05-14
**Type**: Runtime Interaction Model / Turn-Loop Reliability
**Status**: Implemented

## Overview

Evolve the turn-loop continuation model so tool-capable interactions feel natural across languages while still preventing false-success completions.

The runtime should continue based on task state and action evidence, not primarily on English-only narration patterns such as "I will..." or "Proceeding...".

## Problem Statement

The current hardening behavior is effective at preventing some false-success completions, but the default package-level narration detection relies on English regex patterns.

That creates two problems:

- multilingual or mixed-language chats may bypass the default narration guard because they do not match the English phrases
- hosts that want natural agent behavior still have to reason about intent-rejection heuristics instead of a stronger language-agnostic notion of "unfinished work without evidence"

In practice, mature coding agents feel natural because continuation is driven by task progress, tool results, permissions, and explicit completion state, not by whether the assistant happened to use a specific English future-tense phrase.

The remaining gap is structural control signaling. The runtime now handles unresolved narration much more safely, but agent-mode completion still depends on interpreting some plain text because there are no explicit internal control tools for deterministic final-answer, needs-input, or blocked outcomes.

## Goals

- Make tool-capable continuation behavior language-agnostic.
- Preserve the core guarantee that narrated intent is not treated as executed work.
- Reduce dependence on English-only intent-rejection heuristics.
- Ensure the runtime can keep interacting with the LLM internally on unresolved tool-capable turns without depending on the client to manually continue the turn.
- Ensure this default continuation behavior is package/API-owned and does not depend on environment-variable configuration.
- Let hosts refine unfinished-work policy semantically rather than through phrase matching.
- Keep conversational, non-tool-dependent interactions natural and low-friction.
- Preserve bounded recovery and explicit stop reasons for unresolved turns.
- Add explicit agent-mode control outputs so completion, user-input requests, and blocked states can stop deterministically without relying on plain-text interpretation.

## Non-Goals

- Guarantee perfect narration detection for every human language using regex alone.
- Introduce hidden chain-of-thought requirements or planner-only workflows.
- Force all hosts to use the same product UX for streaming, progress, or final-message rendering.
- Eliminate host-owned policy hooks such as `requiresActionEvidence(...)` or `classifyTextResponse(...)`.
- Redesign unrelated provider clients or built-in tool implementations.
- Replace existing user-facing workspace tools with control tools; the new control tools are additive runtime protocol tools, not replacements for normal tool execution.

## Functional Requirements

### Continuation Model

- **REQ-1**: The runtime must support continuation decisions based on unresolved task state and missing action evidence, not only on surface-form narration phrases.
- **REQ-2**: For tool-capable turns, non-empty assistant text must not be considered successful final completion solely because it is non-empty when required action evidence is still missing.
- **REQ-3**: The default runtime continuation behavior for unresolved tool-capable turns should remain valid regardless of the assistant message language.
- **REQ-3a**: The default runtime behavior for unresolved tool-capable turns must continue or retry internally without requiring the client to inject a follow-up user turn or custom continuation loop.
- **REQ-4**: The runtime must preserve the distinction between:
  - accepted final response text
  - actionable tool-call response
  - rejected or unresolved text response
  - empty or non-progressing response

### Language-Agnostic Guardrails

- **REQ-5**: The package must not rely exclusively on English-only narration regexes to protect tool-capable turns from false-success completion.
- **REQ-6**: Any built-in phrase-based narration detection that remains should be treated as a fallback heuristic rather than the primary correctness mechanism.
- **REQ-7**: Hosts must be able to enforce narration rejection or unresolved-text continuation without needing language-specific phrase libraries.
- **REQ-8**: Mixed-language, non-English, or locale-specific assistant text must still be subject to the same unfinished-work rule when required action evidence is absent.

### Host Policy Surface

- **REQ-9**: The runtime must provide a package-owned default continuation policy for tool-capable turns so basic safe continuation does not require host-supplied classification logic.
- **REQ-9a**: `respondWithTools(...)` must inject a runtime-owned agent run loop contract so callers get strong tool-loop instructions by default without having to rediscover or duplicate them.
- **REQ-9b**: That runtime-owned prompt should explicitly state that narration is not completion, that inspection/search/tool use should proceed through tools, and that stopping is limited to tool use, evidence-backed final answers, required missing user input, or permission/safety blocks.
- **REQ-10**: The runtime must still provide a host-usable policy surface for deciding whether a text response is truly final or whether the turn still requires action evidence.
- **REQ-11**: That policy surface must support language-agnostic classification based on state, prior tool results, and completion conditions.
- **REQ-12**: Hosts must be able to keep purely conversational turns permissive while applying stricter continuation rules only to action-dependent turns.
- **REQ-13**: Hosts must be able to supply custom classification behavior without forking provider-specific response handling.

### Agent-Mode Control Protocol

- **REQ-13a**: In agent mode, the runtime must expose internal control tools for deterministic terminal control, in addition to normal workspace or product tools.
- **REQ-13b**: The runtime must provide a `final_answer` control tool with the shape `{ answer: string, evidenceRefs?: string[] }`.
- **REQ-13c**: The runtime must provide a `need_user_input` control tool with the shape `{ question: string, reason: string }`.
- **REQ-13d**: The runtime must provide a `blocked` control tool with the shape `{ reason: string }`.
- **REQ-13e**: In agent mode, a valid `final_answer(...)` control call must allow the runtime to stop deterministically as a successful final answer, subject to any configured evidence validation.
- **REQ-13f**: In agent mode, a valid `need_user_input(...)` control call must allow the runtime to stop deterministically with a needs-user-input outcome instead of relying on plain-text interpretation.
- **REQ-13g**: In agent mode, a valid `blocked(...)` control call must allow the runtime to stop deterministically with a blocked outcome instead of relying on plain-text interpretation.
- **REQ-13h**: In agent mode, bare assistant text that is neither a valid workspace-tool call nor a valid runtime control call must be treated as a protocol violation or unresolved response and should continue through bounded recovery rather than being accepted as a deterministic stop by default.

### Bounded Recovery

- **REQ-14**: When a tool-capable turn is unresolved, the runtime must continue or stop through an explicit bounded recovery path rather than silently accepting the text.
- **REQ-14a**: When action evidence is still required, the default rejected-text retry budget must allow more than one automatic internal recovery attempt unless the host explicitly overrides it.
- **REQ-15**: Recovery must remain bounded by retry limits, iteration limits, repeated-tool-call guards, timeout limits, or equivalent explicit controls.
- **REQ-16**: When recovery stops, the runtime must return an explicit non-success terminal reason rather than implying that work completed successfully.

### Completion Integrity

- **REQ-17**: Successful final completion metadata must correspond to an accepted final response, not merely to streamed or interim assistant text.
- **REQ-18**: Rejected or unresolved text must remain distinguishable to hosts so they can avoid presenting it as the final completed answer.
- **REQ-19**: A verified final answer may still complete successfully without a new tool call when it is grounded in already available evidence.
- **REQ-19a**: Agent-mode final-answer completion should prefer the explicit `final_answer(...)` control path over ambiguous plain-text finalization whenever the runtime is operating under the structured control protocol.

### Backward Compatibility

- **REQ-20**: Existing hosts that already use `requiresActionEvidence(...)`, `classifyTextResponse(...)`, and `onRejectedTextResponse(...)` must remain supported.
- **REQ-20a**: Hosts must be able to accept a final text response explicitly after evidence exists, even when their own `requiresActionEvidence(...)` policy remains conservative.
- **REQ-20b**: The package must continue to stop on `tool_calls_response` when a host intentionally does not request continuation after tool execution, but that contract must be documented and regression-tested.
- **REQ-20c**: Existing hosts that still rely on text classification must remain supportable while the runtime introduces the new agent-mode control tools as an additive protocol.
- **REQ-21**: Existing narrow plain-text tool-intent normalization should remain compatible where explicitly configured.
- **REQ-22**: Existing English narration heuristics may remain available for backward compatibility, but they must not remain the sole correctness path for action-dependent continuation.

## Non-Functional Requirements

- **NFR-1 (Natural Interaction)**: Tool-capable agent flows should feel natural to users across languages without requiring manual follow-up prompts just because the assistant phrased progress text differently.
- **NFR-2 (Reliability)**: The runtime must continue to prevent false-positive successful completions for action-dependent turns.
- **NFR-3 (Determinism)**: Given the same host policy inputs and runtime state, continuation outcomes must be deterministic.
- **NFR-4 (Extensibility)**: Hosts must be able to specialize continuation policy for domain-specific workflows without changing the provider layer.

## Constraints

- `src/turn-loop.ts` remains the package-owned boundary for generic turn-loop repetition and response classification.
- Tool execution, persistence, and transcript presentation remain host-owned concerns.
- The runtime must remain provider-agnostic.
- The solution must not depend on external language detection services.
- The default continuation behavior must not be enabled or disabled through environment variables.

## Acceptance Criteria

- [x] A tool-capable turn whose assistant reply is in a non-English or mixed-language narration style does not complete successfully when required action evidence is still absent.
- [x] A tool-capable turn can continue through bounded internal recovery even when unresolved narration does not match the current English fallback patterns.
- [x] A client using the default package behavior does not need to send an extra follow-up user message or implement its own continuation loop to keep an unresolved tool-capable turn moving.
- [x] A client using the default package behavior does not need to set an environment variable to enable safe internal continuation for unresolved tool-capable turns.
- [x] `respondWithTools(...)` injects a runtime-owned agent run loop prompt that permits progress narration but does not allow narration alone to count as completion.
- [x] The default rejected-text retry budget for action-dependent turns allows at least two bounded automatic retries unless a host overrides it.
- [x] A conversational turn that does not require action evidence can still complete normally regardless of response language.
- [x] Hosts can still implement language-agnostic final-response policy through existing or evolved classification hooks.
- [x] Hosts can explicitly classify a text response as final after evidence exists, and that override is covered by unit tests.
- [x] Successful final completion still requires either a verified final answer or action evidence.
- [x] Rejected or unresolved text remains visible to hosts as a non-final outcome rather than being indistinguishable from an accepted final answer.
- [x] The `onToolCallsResponse(...)` continuation contract is documented and covered by unit tests so accidental stop behavior is detectable.
- [x] Existing hosts that rely on the current hardening callbacks remain compatible after the change.
- [x] In agent mode, the runtime exposes additive internal control tools for `final_answer`, `need_user_input`, and `blocked`.
- [x] A `final_answer(...)` control call stops deterministically as the final answer path and can carry optional evidence references.
- [x] A `need_user_input(...)` control call stops deterministically as a needs-user-input outcome.
- [x] A `blocked(...)` control call stops deterministically as a blocked outcome.
- [x] In agent mode, bare text that does not use a runtime control tool or workspace tool is treated as protocol-invalid or unresolved and is nudged to continue instead of being treated as a deterministic stop.
- [x] The runtime keeps normal workspace tool execution semantics unchanged: workspace tool call executes and continues.
- [x] Existing text-classification hosts remain supported during the transition to the structured control protocol.
- [x] The runtime-owned system prompt explicitly frames execution as an agent run loop and states that the model should stop only by calling tools, producing a final answer supported by run evidence, requesting required missing user input, or reporting a permission or safety block.

## References

- `README.md`
- `src/turn-loop.ts`
- `src/runtime.ts`
- `tests/llm/turn-loop.test.ts`
- `.docs/req/2026/04/12/req-llm-action-execution-hardening.md`