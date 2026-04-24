# Requirement: Human Input Choice Schema

**Date**: 2026-04-24
**Type**: Runtime Tool Contract / Human-In-The-Loop Input
**Status**: Proposed

## Overview

Improve the built-in human-input tool contract so interactive harnesses can present single-select and multiple-select questions using stable option identifiers, optional descriptions, and explicit skip behavior.

The public request schema for the tool should be:

```ts
{
  type?: "single-select" | "multiple-select";
  allowSkip?: boolean;
  questions: Array<{
    header: string;
    id: string;
    question: string;
    options: Array<{
      id: string;
      label: string;
      description?: string;
    }>;
  }>;
}
```

## Problem Statement

The current human-input contract is too narrow for richer interactive flows. It can ask questions with labeled options, but it does not clearly expose:

- whether the user should choose one option or multiple options
- whether the user may skip the prompt
- stable option identifiers for machine-readable answer handling
- optional option descriptions for concise UI context

Without these fields, harnesses must infer selection behavior from prompt text or labels, which makes user responses harder to validate and less stable across UI copy changes.

## Goals

- Add an explicit `type` field for `"single-select"` and `"multiple-select"` prompts.
- Add an explicit `allowSkip` field for dismissible prompts.
- Require stable `id` values on options.
- Allow option descriptions to be omitted when labels are self-explanatory.
- Keep the schema compact and avoid a separate `kind` discriminator.
- Remove the legacy flat `question` / `options` payload shape.

## Non-Goals

- Adding a separate `kind` field for approvals versus questions.
- Adding free-form text input in this requirement.
- Defining provider-specific model prompting behavior beyond the tool contract.
- Changing unrelated built-in tool contracts.

## Functional Requirements

### Request Shape

- **REQ-1**: The human-input tool parameters must accept an optional top-level `type` field.
- **REQ-2**: `type` must allow exactly `"single-select"` and `"multiple-select"`.
- **REQ-3**: The human-input tool parameters must accept an optional top-level `allowSkip` boolean.
- **REQ-4**: The human-input tool parameters must require a `questions` array.
- **REQ-5**: Each question must include `header`, `id`, `question`, and `options`.
- **REQ-6**: Each option must include stable `id` and user-facing `label` fields.
- **REQ-7**: Each option may include an optional `description` field.

### Selection Semantics

- **REQ-8**: When `type` is omitted, the runtime or harness must treat the prompt as `"single-select"`.
- **REQ-9**: When `type` is `"single-select"`, each answered question must produce exactly one selected option unless the prompt is skipped.
- **REQ-10**: When `type` is `"multiple-select"`, each answered question may produce multiple selected option IDs unless the prompt is skipped.
- **REQ-11**: When `allowSkip` is omitted or `false`, the harness should require an answer before resuming the turn.
- **REQ-12**: When `allowSkip` is `true`, the harness may resume with an explicit skipped result.

### Validation

- **REQ-13**: Question `id` values must be non-empty strings.
- **REQ-14**: Option `id` values must be non-empty strings.
- **REQ-15**: Option `id` values must be unique within a question.
- **REQ-16**: `questions` must contain at least one question.
- **REQ-17**: Each question must contain at least two options.

### Strict Shape

- **REQ-18**: Existing `ask_user_input` callers that omit `type` must continue to work as single-select prompts when they provide structured `questions`.
- **REQ-19**: Existing `human_intervention_request` alias behavior must remain aligned with `ask_user_input` for the structured schema.
- **REQ-20**: Flat `question` / `options`, `prompt`, `defaultOption`, `default_option`, `timeoutMs`, and `metadata` payload fields must be rejected.

## Non-Functional Requirements

- **NFR-1 (Clarity)**: The schema must be obvious enough for models and harness code to use without needing a separate `kind` field.
- **NFR-2 (Stability)**: Answer handling must use option IDs rather than labels whenever IDs are present.
- **NFR-3 (Clarity)**: The runtime must expose one supported HITL payload shape rather than maintaining flat-shape compatibility.
- **NFR-4 (UI Independence)**: The runtime contract must not require a specific UI rendering style.

## Constraints

- `ask_user_input` remains the preferred public tool name.
- `human_intervention_request` remains a legacy alias and must not diverge from `ask_user_input`.
- The schema must remain JSON-schema friendly for provider tool definitions.

## Acceptance Criteria

- [ ] The built-in human-input tool schema exposes `type?: "single-select" | "multiple-select"`.
- [ ] The built-in human-input tool schema exposes `allowSkip?: boolean`.
- [ ] Question options use required stable `id` fields.
- [ ] Option `description` is optional.
- [ ] Omitting `type` behaves as `"single-select"`.
- [ ] Multiple-select prompts can return multiple selected option IDs.
- [ ] Skipped prompts have an explicit skipped result when `allowSkip` is enabled.
- [ ] Flat `question` / `options` payloads are rejected.
- [ ] README or public docs describe the updated request schema and selection semantics.
- [ ] Tests cover schema validation, default single-select behavior, multiple-select behavior, and skip behavior.

## References

- `README.md`
- `src/builtins.ts`
- `src/types.ts`
- `src/tool-validation.ts`
- `tests/llm/runtime.test.ts`
