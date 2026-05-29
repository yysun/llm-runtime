# Runtime Completion Gates

## Requirement

`complete()` must keep running until the task is actually done, blocked, waiting on host-owned tool handling, or stopped by a guard. Tool availability is not task intent.

## Acceptance Criteria

- `completionGate` is available on runtime completion options.
- `final_answer` is accepted by default unless an explicit gate rejects it.
- Mutation evidence is required only when `completionGate.requireToolEvidence.kind` is `mutation`.
- `evidenceKind` describes a tool capability, not a task requirement.
- A mutation gate rejects final text and premature `final_answer` until a successful matching mutating tool result exists.
- Matching mutation evidence honors optional `toolNames`.
- Host-owned tool batches are atomic: if any call in a batch is host-owned, runtime executes none of the batch and returns `status: "tool_calls"` with the full batch for host resume.
- Known non-executable tools are host-owned. Unknown tools remain runtime errors.
- Runtime-owned executable batches still execute and continue normally.

## Non-Goals

- Do not add `need_user_input`.
- Do not add a separate human-input wait state.
- Do not broaden the public API beyond the explicit completion gate.
