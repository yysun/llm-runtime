---
title: "Built-In Executors"
type: "feature"
status: "active"
source_paths:
  - "src/builtin-executors.ts"
  - "src/builtins.ts"
  - "src/types.ts"
updated_at: "2026-04-12"
---

`src/builtin-executors.ts` contains the package-owned implementations behind the reserved built-in tool catalog.

Facts from source:
- File and shell executors enforce a trusted working-directory scope rather than accepting arbitrary filesystem access.
- `load_skill` resolves content from the configured skill registry and returns structured skill context text.
- `human_intervention_request` does not call a host adapter or block for approval. It validates `question` and `options`, then returns a serialized `PendingHitlToolResult`.
- The HITL payload includes `status: "pending"`, `confirmed: false`, `selectedOption: null`, a `requestId` derived from `toolCallId` when available, plus optional `defaultOption`, `timeoutMs`, and `metadata`.
- `shell_cmd` resolves an optional `directory` under the trusted working directory, executes with `shell: false`, ignores stdin, captures stdout/stderr, and terminates on timeout.

Why this matters:
- The runtime owns the request envelope for approval, but the harness owns presenting the question, collecting the human decision, persisting it, and resuming execution.
- HITL is therefore a package feature with host-mediated completion, not an in-package interactive approval loop.
- Shell execution has some guardrails, but the executor still runs any available binary under the host process identity. There is no built-in allowlist, sandbox, or read-only permission gate for `shell_cmd`.

Read this with [[src-builtins]] for catalog shape, [[approval-and-synthetic-tool-call-messages]] for how pending approval artifacts differ from synthetic tool-call messages produced by the turn loop, and [[shell-command-safeguards]] for the detailed `shell_cmd` protections and limitations.