---
title: "Built-In Executors"
type: "feature"
status: "active"
language: "default"
source_paths:
  - ".docs/reqs/2026/04/24/req-human-input-choice-schema.md"
  - ".docs/reqs/2026/05/14/req-builtin-filesystem-tools.md"
  - "src/builtin-executors.ts"
  - "src/builtins.ts"
  - "src/human-input-contract.ts"
  - "src/types.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-15"
---

`src/builtin-executors.ts` contains the package-owned implementations behind the reserved built-in tool catalog.

Facts from source:
- File and shell executors enforce a trusted working-directory scope rather than accepting arbitrary filesystem access.
- `load_skill` resolves content from the configured skill registry and returns structured skill context text.
- `ask_user_input` validates a structured `questions[]` array, defaults `type` to `single-select`, preserves `allowSkip`, and returns a serialized `PendingHitlToolResult` instead of calling a host adapter.
- The current pending HITL payload includes `status: "pending"`, `confirmed: false`, a `requestId` derived from `toolCallId` when available, the normalized selection `type`, `allowSkip`, and the validated `questions` array.
- `shell_cmd` resolves an optional `directory` under the trusted working directory, executes with `shell: false`, ignores stdin, captures stdout/stderr, and terminates on timeout.
- `search_files` walks the trusted workspace, ignores common noise such as `node_modules`, `.git`, and `dist`, and returns deterministic sorted matches for the requested path pattern.
- `create_directory` creates directories recursively inside the trusted workspace and reports whether the target was newly created or already existed.
- `path_exists` reports whether a path exists and, when it does, whether it is a file or directory.

Why this matters:
- The runtime owns the request envelope for approval, but the harness owns presenting the question, collecting the human decision, persisting it, and resuming execution.
- HITL is therefore a package feature with host-mediated completion, not an in-package interactive approval loop.
- The filesystem trio gives models narrow, structured workspace primitives for discovery, directory creation, and existence checks without forcing a shell command for every routine task.
- Shell execution has some guardrails, but the executor still runs any available binary under the host process identity. There is no built-in allowlist, sandbox, or read-only permission gate for `shell_cmd`.

Read this with [[src-builtins]] for catalog shape, [[approval-and-synthetic-tool-call-messages]] for how pending approval artifacts differ from synthetic tool-call messages produced by the turn loop, and [[shell-command-safeguards]] for the detailed `shell_cmd` protections and limitations.