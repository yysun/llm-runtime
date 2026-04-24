# Test Spec: Human Input Choice Schema

**Date**: 2026-04-24
**Requirement**: `.docs/reqs/2026/04/24/req-human-input-choice-schema.md`
**Plan**: `.docs/plans/2026/04/24/plan-human-input-choice-schema.md`
**Status**: Proposed

## Scope

Verify that the built-in human-input tools expose and execute the structured choice schema for single-select and multiple-select prompts while rejecting legacy flat-call fields.

The covered tool names are:

- `ask_user_input`
- `human_intervention_request`

## Out Of Scope

- Rendering a specific application UI.
- Processing the eventual human response after the pending artifact is returned.
- Adding free-form text answers.
- Changing provider invocation behavior outside tool schema exposure and tool execution.

## Preconditions

- Built-in tools are enabled.
- `resolveTools()` returns both `ask_user_input` and `human_intervention_request`.
- HITL tools return pending artifacts without requiring an external human-input adapter.

## Scenario 1: Structured Schema Is Exposed

**Given** the runtime resolves built-in tools  
**When** a caller inspects `ask_user_input.parameters`  
**Then** the schema exposes:

- `type` with allowed values `single-select` and `multiple-select`
- `allowSkip` as a boolean
- `questions` as an array
- question fields `header`, `id`, `question`, and `options`
- option fields `id`, `label`, and optional `description`

**And** `human_intervention_request.parameters` exposes the same structured capability.

## Scenario 2: Default Single-Select Prompt

**Given** `ask_user_input` is executed with a structured `questions[]` payload and no `type`  
**When** the tool returns a pending artifact  
**Then** the artifact includes:

- `status: "pending"`
- `pending: true`
- `type: "single-select"`
- `allowSkip: false`
- the original structured `questions[]`
- each option `id` and `label`

**And** legacy flat artifact fields such as `selectedOption`, `question`, and `options` are absent.

## Scenario 3: Multiple-Select Prompt

**Given** `ask_user_input` is executed with `type: "multiple-select"`  
**And** the question contains at least two options with stable IDs  
**When** the tool returns a pending artifact  
**Then** the artifact preserves `type: "multiple-select"`  
**And** the artifact preserves all structured question and option IDs.

## Scenario 4: Skip-Allowed Prompt

**Given** `ask_user_input` is executed with `allowSkip: true`  
**When** the tool returns a pending artifact  
**Then** the artifact includes `allowSkip: true`  
**And** no answer is fabricated by the runtime.

## Scenario 5: Required Structured Question Validation

**Given** `ask_user_input` is executed with a structured `questions[]` payload  
**When** a question is missing one of `header`, `id`, `question`, or `options`  
**Then** the tool returns a validation error artifact or deterministic error string  
**And** the error identifies the invalid question path.

## Scenario 6: Required Structured Option Validation

**Given** `ask_user_input` is executed with a structured question  
**When** an option is missing `id` or `label`  
**Then** the tool rejects the call  
**And** the error identifies the invalid option path.

## Scenario 7: Duplicate Option IDs Are Rejected

**Given** `ask_user_input` is executed with a structured question  
**When** two options in the same question use the same `id`  
**Then** the tool rejects the call  
**And** the error explains that option IDs must be unique within a question.

## Scenario 8: Structured Questions Require At Least Two Options

**Given** `ask_user_input` is executed with a structured question  
**When** the question has fewer than two options  
**Then** the tool rejects the call  
**And** the error explains that at least two options are required.

## Scenario 9: Invalid Type Is Rejected

**Given** `ask_user_input` is executed with `type: "approval"`  
**When** the tool validates the call  
**Then** the tool rejects the call  
**And** the error states that only `single-select` and `multiple-select` are supported.

## Scenario 10: Invalid AllowSkip Is Rejected

**Given** `ask_user_input` is executed with `allowSkip: "yes"`  
**When** the tool validates the call  
**Then** the tool rejects the call  
**And** the error states that `allowSkip` must be a boolean.

## Scenario 11: Legacy Flat Calls Are Rejected

**Given** `human_intervention_request` is executed with:

```json
{
  "question": "Approve?",
  "options": ["Yes", "No"],
  "defaultOption": "Yes"
}
```

**When** the tool returns a pending artifact  
**Then** the tool rejects the call with a validation artifact
**And** the artifact identifies `question` and/or `options` as unknown parameters.

## Scenario 12: Legacy Aliases Are Rejected

**Given** `ask_user_input` is executed with:

```json
{
  "prompt": "Continue?",
  "options": "Yes",
  "default_option": "Yes"
}
```

**When** the tool validates the call
**Then** `prompt`, `options`, and `default_option` are rejected as unsupported parameters.

## Scenario 13: Alias Behavior Stays Equivalent

**Given** equivalent structured payloads are passed to `ask_user_input` and `human_intervention_request`  
**When** both tools return pending artifacts  
**Then** both artifacts have equivalent `type`, `allowSkip`, and `questions`
**And** only `requestId` may differ based on the tool-call context.

## Scenario 14: Unknown Top-Level Fields Are Rejected

**Given** a HITL tool is executed with an unsupported top-level field  
**When** shallow schema validation runs  
**Then** the tool rejects the call with a tool-parameter validation artifact  
**And** the artifact identifies the unknown parameter.

## Scenario 15: Documentation Matches Runtime Contract

**Given** public README documentation describes `ask_user_input`  
**When** a caller compares the documented schema with the resolved tool schema  
**Then** the documented fields match the runtime-supported structured request shape  
**And** the README explains:

- omitted `type` defaults to `single-select`
- omitted `allowSkip` defaults to `false`
- `human_intervention_request` is a legacy alias
- legacy flat calls are rejected

## Scenario 16: E2E Dry Run Verifies HITL Strict Schema

**Given** the package showcase E2E runner is executed in dry-run mode
**When** the runner resolves package tools through `resolveToolsAsync`
**Then** it verifies:

- `ask_user_input` and `human_intervention_request` are both executable when either HITL alias is enabled
- both aliases expose the same schema
- structured `multiple-select` payloads produce pending artifacts with `allowSkip`
- pending artifacts do not include legacy flat fields
- legacy flat payloads are rejected
- unknown top-level HITL parameters are rejected

## Expected Verification Commands

```bash
npm test
npm run check
npm run test:e2e:dry-run
```

## Traceability

- Covers REQ-1 through REQ-20 from the requirement document.
- Covers AP implementation tasks for `src/types.ts`, `src/builtins.ts`, `src/builtin-executors.ts`, `src/tool-validation.ts`, `README.md`, and `tests/llm/runtime.test.ts`.
