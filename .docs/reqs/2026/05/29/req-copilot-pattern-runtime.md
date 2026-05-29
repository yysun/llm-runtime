# Requirement: Copilot Pattern Runtime

## Problem

The runtime must not depend on a model always calling `final_answer` to finish a turn. That is a brittle protocol: useful as a semantic signal, but not reliable enough to be the only completion path.

The desired behavior is closer to Copilot's split:

- mechanical loop state decides whether the run can stop,
- semantic completion signals improve confidence when the model follows the protocol,
- generic evidence prevents premature final answers after host interaction.

## Acceptance Criteria

- Host-owned tools such as `ask_user_input` are returned as `tool_calls` for the host to handle and resume later.
- `complete()` and `streamComplete()` use the same completion semantics.
- `final_answer` remains supported and preferred, but plain assistant text with no tool calls can terminate when generic runtime evidence supports completion.
- Plain assistant text immediately after only `ask_user_input` evidence is rejected and the loop continues.
- File/setup work is allowed to finish after successful action evidence even if the model sends plain assistant text instead of calling `final_answer`.
- The runtime stays host-agnostic; it must not encode Agent World, `AGENTS.md`, or CLI-specific process knowledge.
- The managed prompt describes `final_answer` as preferred, not mandatory.
- Tests cover buffered and streaming paths for host input, rejected premature completion, and accepted evidence-backed plain completion.
