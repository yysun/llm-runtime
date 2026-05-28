# Test Spec: Human Input Choice Schema

**Date**: 2026-04-24  
**Requirement**: `.docs/reqs/2026/04/24/req-human-input-choice-schema.md`  
**Plan**: `.docs/plans/2026/04/24/plan-human-input-choice-schema.md`  
**Status**: Superseded by host-owned `ask_user_input`

## Scope

Verify that the built-in `ask_user_input` schema exposes structured choice prompts for single-select and multiple-select requests.

The runtime no longer executes default human-input tools. `ask_user_input` is model-visible and host-owned: when the model calls it during runtime completion, the loop stops with `status: "tool_calls"` and returns the original tool call to the host.

## Out Of Scope

- Rendering a specific application UI.
- Processing the eventual human response after the host-owned tool call is returned.
- Adding free-form text answers.
- Reintroducing legacy HITL alias tools.

## Preconditions

- Built-in tools are enabled.
- `resolveTools()` returns `ask_user_input`.
- The resolved default `ask_user_input` definition has no `execute` function.

## Scenario 1: Structured Schema Is Exposed

**Given** the runtime resolves built-in tools  
**When** a caller inspects `ask_user_input.parameters`  
**Then** the schema exposes:

- `type` with allowed values `single-select` and `multiple-select`
- `allowSkip` as a boolean
- `questions` as an array
- question fields `header`, `id`, `question`, and `options`
- option fields `id`, `label`, and optional `description`

## Scenario 2: Default Completion Hands The Call To The Host

**Given** `runtime.complete(...)` exposes default built-ins  
**When** the model calls `ask_user_input` with a structured `questions[]` payload  
**Then** completion returns `status: "tool_calls"`  
**And** the result includes the assistant message plus the original `ask_user_input` tool call  
**And** the runtime does not append a fabricated tool result.

## Scenario 3: Host Resume Uses Normal Tool Messages

**Given** completion returned an `ask_user_input` tool call  
**When** the host appends a `role: "tool"` result message for that tool call id and calls `complete(...)` again  
**Then** the runtime continues from the updated transcript.

## Scenario 4: Executable Host Override Still Runs Normally

**Given** the host supplies executable `ask_user_input` through `extraTools` or `tools`  
**When** the model calls that tool  
**Then** runtime completion executes the host tool and continues with the returned tool result.

## Expected Verification Commands

```bash
npm test
npm run check
```
