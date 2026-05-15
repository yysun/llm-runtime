# Requirement: HITL Evidence And Pending Input Suspension

**Date**: 2026-05-15
**Type**: HITL / Completion Loop / Agent Control
**Status**: Implemented

## Overview

Tighten the runtime's human-in-the-loop behavior so it does not encourage premature clarification, does not let hosts resume from fake pending HITL artifacts, and does not infer action evidence solely from emitted tool calls when a host callback has not confirmed that real work occurred.

## Problem Statement

The current runtime exposes `ask_user_input` as the preferred path for clarification and approvals, but its description still nudges models toward asking humans too early instead of exhausting safe runtime evidence first. The returned HITL artifact marks the interaction as pending, but it does not tell the host why the run must stop or that the loop must stay suspended until a real user response arrives. Separately, `complete(...)` observes emitted tool calls as action evidence before a host confirms that the tool round actually produced durable evidence, which can let final-answer acceptance get ahead of real execution.

The runtime needs a focused hardening pass so HITL suspension is explicit and durable, and so action evidence is acknowledged by the harness instead of inferred from intent alone.

## Goals

- Make the preferred HITL tool description discourage premature clarification when safe runtime inspection or lookup work should happen first.
- Return an explicit pending-user-input terminal reason that clients can use to suspend the loop until a genuine human answer is supplied.
- Require explicit host acknowledgment before tool-call rounds count as action evidence for final-answer acceptance.
- Preserve existing behavior for non-HITL tool execution and valid explicit control-tool terminal responses unless the new requirement says otherwise.

## Non-Goals

- Redesign the HITL schema away from structured `questions[]` prompts.
- Remove legacy HITL aliases.
- Replace host-owned persistence, transcript storage, or UI behavior.
- Introduce a new external workflow or approval framework.

## Functional Requirements

### HITL Tool Guidance

- **REQ-1**: The `ask_user_input` built-in description must stop encouraging clarification before the model has used safe, relevant, non-human runtime evidence sources.
- **REQ-2**: The preferred description must still make it clear that `ask_user_input` is the correct tool when required human input, approval, or a true missing user decision is blocking progress.
- **REQ-3**: Legacy alias descriptions must remain compatible with the updated preferred guidance.

### Durable Pending User Input State

- **REQ-4**: The built-in HITL executor must return a real terminal reason that identifies the tool result as pending user input rather than a generic pending payload.
- **REQ-5**: The returned HITL artifact must make it explicit that the run is suspended and must not continue until a genuine human response is supplied.
- **REQ-6**: Hosts must be able to distinguish this runtime-generated pending-user-input result from arbitrary user-crafted tool messages that only say `{ "pending": true }`.
- **REQ-7**: Existing structured HITL fields such as `requestId`, `type`, `allowSkip`, and `questions` must remain available.

### Explicit Action Evidence Acknowledgment

- **REQ-8**: `complete(...)` must not treat emitted tool calls by themselves as action evidence.
- **REQ-9**: `onToolCallsResponse(...)` must have an explicit way to acknowledge that the handled tool-call round produced action evidence.
- **REQ-10**: If the host does not acknowledge action evidence, final-text acceptance must remain subject to the same no-evidence restrictions even when tool calls were emitted.
- **REQ-11**: Interaction-only rounds such as HITL prompts must remain distinguishable from real action evidence.
- **REQ-12**: The action-evidence acknowledgment path must be additive and must not break existing hosts that only continue the loop without providing the new acknowledgment.

### Completion-Loop Suspension

- **REQ-13**: When a handled tool-call round results in pending user input, the completion loop must stop with a specific pending-user-input terminal reason instead of continuing.
- **REQ-14**: The stop reason must be derived from the confirmed tool result artifact, not only from the emitted tool name.
- **REQ-15**: The loop must not accept a host-inserted fake pending marker as sufficient proof that a true HITL suspension occurred.
- **REQ-16**: Existing `need_user_input` and `blocked` control tools must keep their distinct stop reasons and semantics.

## Non-Functional Requirements

- **NFR-1 (Safety)**: HITL runs must suspend deterministically until genuine user input is available.
- **NFR-2 (Evidence Integrity)**: Final-answer evidence policy must rely on confirmed execution outcomes rather than emitted intent.
- **NFR-3 (Compatibility)**: Existing structured HITL payloads and agent-control APIs must remain source-compatible where possible.
- **NFR-4 (Minimality)**: Changes should stay focused on tool descriptions, HITL artifacts, loop stop reasons, callback acknowledgment, and related tests/docs.

## Constraints

- Preserve the existing structured `questions[]` HITL schema.
- Follow the source file comment-block convention on all edited source files.
- Add focused unit coverage for runtime and completion-loop behavior; no new E2E spec is required unless unit tests prove insufficient.

## Acceptance Criteria

- [x] `ask_user_input` and its exposed aliases no longer encourage premature clarification before safe runtime inspection or lookup.
- [x] HITL executor results include an explicit pending-user-input terminal reason and suspended state that a host can trust.
- [x] The completion loop can stop on confirmed pending-user-input tool results without relying on generic `{ "pending": true }` markers.
- [x] `onToolCallsResponse(...)` can explicitly acknowledge action evidence separately from generic continuation.
- [x] Tool-call emission alone no longer satisfies action-evidence requirements.
- [x] Existing valid `need_user_input` and `blocked` control-tool behavior remains intact.
- [x] Focused unit tests cover the updated HITL artifact, callback acknowledgment, and completion-loop stop semantics.

## References

- `README.md`
- `src/builtins.ts`
- `src/builtin-executors.ts`
- `src/completion-loop.ts`
- `src/types.ts`
- `tests/llm/runtime.test.ts`
- `tests/llm/turn-loop.test.ts`