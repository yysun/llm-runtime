# Requirement: Action Evidence Separation

**Date**: 2026-05-15
**Type**: Completion Loop Correctness / Human Interaction Safety / Read-Only Search Gating
**Status**: Implemented

## Overview

The completion loop currently treats any current-run tool round as sufficient evidence that work has happened. That is too broad for human-interaction tools such as `ask_user_input`, `ask_user_question`, and `human_intervention_request`. Those tools collect missing information, but they do not prove that the assistant performed the requested task work.

The runtime must separate interaction progress from action evidence so plain-text narration is not accepted merely because a human-interaction tool ran earlier in the same run. It must also steer the model toward safe broad read-only search before asking the user to disambiguate, and reject text that falsely claims search or inspection results without run evidence.

## Problem Statement

The current `complete(...)` wrapper tracks one coarse "observed tool progress" signal. After a human-interaction tool call is handled and the loop continues, a later plain-text reply such as "I will generate the file now" can be accepted because the runtime believes tool progress already occurred.

That behavior is incorrect. Human input can resolve ambiguity or approval, but it is not evidence that the assistant actually read a file, queried a system, wrote an artifact, ran a command, or otherwise performed task work.

There is a second failure mode as well: for safe read-only find/search tasks, the model can reach for `ask_user_input` before attempting a broad lookup, and after the user answers it can narrate unsupported claims such as "I searched records and found no match" without any task tool call. The runtime should guide the model away from premature HITL and reject unsupported evidence claims when no action evidence exists.

## Goals

- Separate human-interaction progress from action evidence inside `complete(...)`.
- Keep plain-text narration rejected by default until current-run action evidence exists.
- Prefer safe broad read-only search over early user-disambiguation prompts for generic lookup tasks.
- Reject result claims that imply completed search/read/write/API work when no action evidence exists.
- Preserve compatibility for existing custom executable tools by counting them as action evidence unless explicitly classified otherwise.
- Apply the same evidence classification when package-managed bound tool execution is used.
- Expose enough trace metadata to make future evidence-gating failures easy to diagnose.

## Non-Goals

- Redesign the host-owned classification hook model.
- Change the deterministic terminal behavior of valid `final_answer`, `need_user_input`, or `blocked` control tools.
- Introduce domain-specific tool semantics tied to a single product area.
- Require hosts to append literal `role: 'tool'` messages in a specific format.

## Functional Requirements

### Evidence Separation

- **REQ-1**: `complete(...)` must track interaction progress and action evidence as separate current-run signals.
- **REQ-2**: `ask_user_input` must count as interaction progress and must not count as action evidence.
- **REQ-3**: Deprecated HITL aliases `ask_user_question` and `human_intervention_request` must count as interaction progress and must not count as action evidence.
- **REQ-4**: `final_answer`, `need_user_input`, and `blocked` must not count as action evidence.
- **REQ-5**: Any other tool call must count as action evidence by default unless an explicit tool definition overrides that classification.

### Prompt And Hint Gating

- **REQ-6**: The default loop prompt must explicitly instruct the model to use read-only tools for inspection, lookup, search, summarization, and analysis without asking for confirmation first.
- **REQ-7**: The default loop prompt must explicitly instruct the model not to ask the user to disambiguate before a safe broad search when multiple records, files, locations, or entity types can be searched read-only.
- **REQ-8**: The default human-intervention hint must instruct the model not to use `ask_user_input` as a substitute for safe read-only lookup, search, or inspection.

### Final Text Gating

- **REQ-9**: When `defaultTextResponseMode` is `require_tool_result`, plain text must remain rejected until current-run action evidence exists.
- **REQ-10**: A plain-text response after only interaction progress must still be classified as non-progressing by default.
- **REQ-11**: Plain text that claims search, lookup, read, write, inspection, or API results without current-run action evidence must be classified as `unsupported_evidence_claim` by default.
- **REQ-12**: A plain-text response after current-run action evidence may be accepted, subject to existing host classification overrides.
- **REQ-13**: Current-run evidence tracking must remain correct when host callbacks compact, summarize, or rebuild message history between iterations.

### Bound Executor Behavior

- **REQ-14**: The package-managed bound tool executor used by `complete(...)` must mark interaction progress and action evidence according to the same classification rules used for normal tool-call responses.
- **REQ-15**: Executing a human-interaction tool through the bound executor must not satisfy the default action-evidence requirement.
- **REQ-16**: Executing a custom executable tool through the bound executor must satisfy the default action-evidence requirement unless explicitly marked otherwise.

### Public Typing And Traceability

- **REQ-17**: `LLMToolDefinition` must support explicit evidence classification metadata so callers can override the default classifier when needed.
- **REQ-18**: Tool-call trace summaries must expose the evidence kind for each tool call and whether that tool call counts as action evidence.
- **REQ-19**: Text-response classification summaries must expose whether interaction progress and action evidence had been observed at classification time.

## Non-Functional Requirements

- **NFR-1 (Safety)**: Interaction-only progress must not be mistaken for completed task work.
- **NFR-2 (Compatibility)**: Existing custom tools must remain action evidence by default unless the caller opts into stricter metadata.
- **NFR-3 (Debuggability)**: Loop traces must reveal why a final text response was accepted or rejected.
- **NFR-4 (Minimality)**: The implementation should stay focused on evidence classification, loop gating, and targeted public metadata.

## Constraints

- Keep the package generic and avoid product-specific tool name assumptions beyond generic interaction and control tool aliases.
- Preserve current host ownership of transcript building, persistence, and domain-specific final-answer classification.
- Follow the existing source-file comment block convention for touched source files.
- Prefer focused unit coverage in `tests/llm/turn-loop.test.ts`; no new E2E spec is required unless unit tests prove insufficient.

## Acceptance Criteria

- [x] `ask_user_input` does not satisfy action evidence.
- [x] Deprecated HITL aliases do not satisfy action evidence.
- [x] `need_user_input`, `final_answer`, and `blocked` do not satisfy action evidence.
- [x] The loop prompt tells the model to use safe read-only search before asking the user to disambiguate.
- [x] The default HITL hint tells the model not to substitute `ask_user_input` for safe read-only lookup or search.
- [x] Plain-text narration after only human input is rejected or retried.
- [x] Unsupported search or inspection claims without action evidence are rejected by default.
- [x] Plain final text after read/write/API/artifact/action tools can be accepted.
- [x] The bound tool executor marks evidence according to tool kind, not merely execution.
- [x] Tool-call traces expose evidence kind and action-evidence status.
- [x] Text-classification traces expose observed interaction progress and observed action evidence.
- [x] Existing custom executable tools remain compatible.
- [x] Focused unit tests cover prompt/hint gating, unsupported evidence claims, interaction-only, interaction-then-action, bound executor behavior, custom-tool defaults, and a scripted package-managed Jazz Gill mock-LLM flow.

## References

- `generic-human-interaction-vs-action-evidence-fix.md`
- `src/completion-loop.ts`
- `src/types.ts`
- `tests/llm/turn-loop.test.ts`