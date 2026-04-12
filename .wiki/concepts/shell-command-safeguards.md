---
title: "Shell Command Safeguards"
type: "concept"
status: "active"
source_paths:
  - "src/builtins.ts"
  - "src/builtin-executors.ts"
  - "src/tool-validation.ts"
  - "src/types.ts"
updated_at: "2026-04-12"
---

The builtin `shell_cmd` executor has several concrete guardrails, but it should be treated as a constrained process launcher rather than a sandbox.

Protections present at `HEAD`:
- `src/builtins.ts` requires a `command` field and rejects undeclared parameters because the tool schema sets `additionalProperties: false`.
- `src/tool-validation.ts` strips `workingDirectory` and `working_directory` from tool arguments, so the model cannot override execution location directly through unapproved fields.
- `src/builtin-executors.ts` resolves the optional `directory` argument relative to a trusted working directory and rejects paths that escape that root.
- The child process is started with `shell: false`, which avoids shell metacharacter expansion and standard shell injection paths.
- Stdin is ignored, stdout/stderr are captured, and timeout is clamped and enforced with `SIGTERM`, which limits hanging interactive commands.

Limits and non-protections:
- There is no executable allowlist or argument allowlist. If the tool is enabled, it can launch any binary available to the host process.
- There is no sandbox, container, uid/gid drop, environment scrubbing, or syscall-level isolation in the executor.
- `shell_cmd` does not currently enforce `toolPermission === "read"` the way `write_file` does, so exposure control mainly happens at tool-selection time.
- The built-in description says it should only be used when the user explicitly asks for a command, but that is prompt guidance, not an executor-side enforcement barrier.

Operational takeaway:
- Enable `shell_cmd` only for harnesses that already trust the working directory, the available binaries, and the calling policy.
- If stronger guarantees are needed, the natural next hardening step is an executor-side allowlist or an explicit permission gate before `spawn(...)`.

Read [[src-builtins]] for catalog and exposure rules, [[src-builtin-executors]] for the implementation boundary, and [[src-tool-validation]] for the deterministic validation layer that runs before execution.