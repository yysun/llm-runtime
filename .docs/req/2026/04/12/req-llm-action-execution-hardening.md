# Requirement: LLM Action Execution Hardening

**Date**: 2026-04-12
**Type**: Bug Fix / Runtime Reliability
**Status**: Proposed

## Overview

Harden the agent turn runtime so tool-capable turns are not marked complete when a weaker model only narrates an intended action instead of actually performing it.

This requirement addresses local models, nano models, and other low-reliability tool users that may reply with text such as "I will check the file", "I will run the command", or "I will search that" without emitting a real tool call and without producing verified results.

## Problem Statement

The current turn loop accepts any non-empty assistant text as a valid terminal response unless it matches a narrow plain-text tool-call fallback pattern.

That behavior is too permissive for weaker models. In practice, some models:

- describe a future action instead of invoking a tool
- acknowledge a task as if work has started when no action occurred
- narrate a plan after tool execution instead of returning the next real action or the final verified result

The result is a false-success turn completion:

- the transcript implies work was performed
- the runtime marks the turn as completed
- no tool call, side effect, or verified result exists to support the claim

This degrades trust in the execution loop and creates inconsistent behavior across providers and model sizes.

## Goals

- Prevent intent-only assistant text from being accepted as successful execution on tool-capable turns.
- Preserve real final answers that do not require tools.
- Preserve valid explicit tool-call outputs and existing narrow plain-text tool-intent recovery where it is already supported.
- Make runtime completion depend on actual action or verified result rather than narration.
- Keep behavior consistent across direct turns and post-tool continuation turns.

## Non-Goals

- Expanding the runtime to infer arbitrary tool arguments from free-form prose.
- Requiring a planner-first architecture.
- Replacing the existing provider abstraction.
- Redesigning transcript UI for this requirement.
- Guaranteeing perfect tool usage for every weak model purely through prompting.

## Functional Requirements

### Runtime Response Classification

- **REQ-1**: The turn runtime must distinguish between:
  - verified final response text
  - executable tool intent
  - empty/non-progressing response
  - intent-only narration
- **REQ-2**: Intent-only narration must not be treated as a successful terminal assistant response when the active turn still requires tool execution or verified action output.
- **REQ-3**: The same classification rule must apply to both:
  - the initial direct-turn model response
  - any continuation response after tool execution

### Intent-Only Narration Guard

- **REQ-4**: When a model produces non-empty assistant text that describes a future action without actually taking that action, the runtime must not immediately persist that text as a completed final response.
- **REQ-5**: The runtime must treat statements such as "I will run", "I will check", "I will search", "I will open", "I will update", or equivalent future-tense action claims as non-terminal when no corresponding tool call or verified result is present.
- **REQ-6**: The runtime must converge safely when such narration occurs by either:
  - requesting a corrected follow-up from the model, or
  - stopping the turn with an explicit non-success outcome or warning state
- **REQ-7**: The runtime must not fabricate side effects, tool results, or tool arguments from arbitrary intent-only prose.

### Tool-Execution Proof Requirement

- **REQ-8**: For turns that require tool execution, assistant narration alone is not proof that work occurred.
- **REQ-9**: Tool execution must be evidenced by at least one of the following before the runtime accepts the action as completed:
  - a valid tool call
  - a durable tool result or error artifact
  - a verified final answer grounded in already-executed tool results
- **REQ-10**: If no such evidence exists, the turn must not be finalized as a successful completed action turn.

### Existing Tool-Intent Fallback

- **REQ-11**: The current explicit plain-text tool-intent fallback may remain supported for narrowly recognized formats that are already intentionally parsed.
- **REQ-12**: This fallback must stay bounded and deterministic.
- **REQ-13**: The fallback must not be broadened into open-ended free-form intent guessing.

### Tool-Parameter Validation and Recovery

- **REQ-14**: When a tool call fails because the model supplied wrong, malformed, unknown, or missing parameters, the failure must be classified as a validation failure, not as a successful action.
- **REQ-15**: The runtime may automatically normalize only safe, deterministic parameter mistakes before execution, including:
  - known parameter aliases
  - unambiguous scalar-to-array coercion
  - unambiguous numeric string conversion
  - omission of null/undefined optional parameters
- **REQ-16**: The runtime may apply provider-specific deterministic argument repair for known provider bugs when the mapping is unambiguous.
- **REQ-17**: The runtime must not invent missing required semantic values or guess ambiguous parameter values from free-form prose.
- **REQ-18**: Missing required values such as file paths, agent targets, questions, URLs, or message payloads must remain validation failures unless the value is explicitly recoverable from a deterministic alias rule.
- **REQ-19**: Validation failures must produce a durable tool error artifact that clearly states what parameter was wrong, missing, malformed, or disallowed.
- **REQ-20**: The model may be given a bounded opportunity to self-correct after a validation failure by observing the durable tool error artifact and emitting a corrected tool call.
- **REQ-21**: Repeated validation failures for the same attempted action must not loop indefinitely; after a bounded retry limit the runtime must stop with an explicit recovery message, warning, or HITL path.

### Provider and Model Policy

- **REQ-22**: The system must support provider/model-specific handling for weak tool users.
- **REQ-23**: Tool-capable turns for weak models must have an explicit runtime policy that reduces false-success completion.
- **REQ-24**: That policy may differ by provider or model class, but the user-visible guarantee must remain the same: narrated intent is not treated as executed work.

### Prompting and Guidance

- **REQ-25**: Tool-usage guidance presented to the model must explicitly forbid describing future tool actions as if they were execution.
- **REQ-26**: When tools are available and needed, the guidance must instruct the model to either:
  - emit the tool call now, or
  - return verified results from prior tool execution
- **REQ-27**: Tool guidance should also make clear that if a tool call fails validation, the model must emit a corrected tool call rather than narrate what it intends to do next.
- **REQ-28**: Prompt guidance alone is not sufficient; runtime validation must remain authoritative.

### Turn Outcome Integrity

- **REQ-29**: The runtime must preserve the existing rule that completed turn metadata reflects actual turn completion, not merely non-empty assistant text.
- **REQ-30**: Intent-only narration must not generate terminal `final_response` completion metadata unless the response is truly final and does not depend on unperformed tool work.
- **REQ-31**: A tool validation failure must not generate terminal success metadata for the turn.
- **REQ-32**: Queue progression and restore behavior must remain aligned with the hardened completion rule.

## Non-Functional Requirements

- **NFR-1 (Reliability)**: The runtime must reduce false-positive completed turns for weak tool-using models.
- **NFR-2 (Determinism)**: The same model response content must be classified consistently in direct and continuation paths.
- **NFR-3 (Safety)**: The runtime must prefer refusing or retrying over inventing actions from ambiguous prose.
- **NFR-4 (Compatibility)**: Existing valid tool-call handling, event isolation, and persisted tool lifecycle guarantees must remain intact.

## Constraints

- In this repository, `src/turn-loop.ts` owns generic response classification while tool execution, persistence, and retry-state integration remain caller-owned through callbacks.
- The provider layer must remain a pure model-client boundary.
- Existing world/chat isolation and event-path guarantees remain in force.
- Existing queue/HITL/tool durability rules remain in force.
- The fix must not rely on real external side effects during tests.

## Acceptance Criteria

- [ ] A direct-turn reply like "I will run the command now" is not persisted as a successful completed final response when no tool call is emitted.
- [ ] A continuation reply like "I will inspect the file next" is not persisted as a successful completed final response when no tool call or verified result is emitted.
- [ ] Existing narrow explicit plain-text tool-intent recovery still works for intentionally supported formats.
- [ ] Real final answers that do not require tools can still complete normally.
- [ ] Tool-capable turns only complete successfully when the runtime has evidence of actual action or verified results.
- [ ] Direct and continuation paths enforce the same hardening rule.
- [ ] Safe deterministic parameter normalization still works for known alias/type/provider-bug cases.
- [ ] Missing or wrong required parameters produce a durable validation error artifact rather than silent success or guessed arguments.
- [ ] The model gets a bounded chance to self-correct after validation failure, but repeated validation failures do not loop indefinitely.
- [ ] Regression coverage exists for at least one direct-turn case and one continuation case using mocked/in-memory boundaries only.

## References

- `src/turn-loop.ts`
- `src/tool-validation.ts`
- `src/runtime.ts`
- `src/openai-direct.ts`
- `src/anthropic-direct.ts`
- `src/google-direct.ts`
- `tests/llm/turn-loop.test.ts`
- `tests/llm/runtime.test.ts`
