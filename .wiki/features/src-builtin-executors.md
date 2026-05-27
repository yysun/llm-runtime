---
title: "Built-In Executors"
type: "feature"
status: "active"
language: "default"
source_paths:
  - ".docs/reqs/2026/04/24/req-human-input-choice-schema.md"
  - ".docs/reqs/2026/05/14/req-builtin-filesystem-tools.md"
  - ".docs/reqs/2026/05/18/req-file-tool-contract-hardening.md"
  - ".docs/done/2026/05/18/file-tool-contract-hardening.md"
  - ".docs/reqs/2026/05/26/req-host-owned-ask-user-input.md"
  - ".docs/done/2026/05/26/host-owned-ask-user-input.md"
  - "src/builtin-executors.ts"
  - "src/builtins.ts"
  - "src/human-input-contract.ts"
  - "src/types.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-27"
---

`src/builtin-executors.ts` contains the package-owned implementations behind the reserved built-in tool catalog.

Facts from source:
- File and shell executors enforce a trusted working-directory scope rather than accepting arbitrary filesystem access.
- `read_file` no longer falls back to skill roots or any other non-workspace location. It reads from the trusted working directory, returns pagination metadata, and allows large pages through caller-supplied `limit`.
- `list_files` and `search_files` make dot-prefixed hidden paths opt-in with `includeHidden`. They do not silently suppress non-hidden directories such as `node_modules` or `dist`.
- `path_exists` uses `lstat` first, so callers can tell an existing symlink from a missing path even when a dangling symlink has no target.
- `load_skill` resolves content from the configured skill registry and returns structured skill context text.
- `ask_user_input` validates a structured `questions[]` array, defaults `type` to `single-select`, preserves `allowSkip`, and returns a serialized `PendingHitlToolResult` instead of calling a host adapter.
- The current pending HITL payload includes `status: "pending"`, `confirmed: false`, a `requestId` derived from `toolCallId` when available, the normalized selection `type`, `allowSkip`, and the validated `questions` array.
- `shell_cmd` resolves an optional `directory` under the trusted working directory, executes with `shell: false`, ignores stdin, captures stdout/stderr, and terminates on timeout.
- `search_files` walks the trusted workspace and returns deterministic sorted matches for the requested path pattern.
- `create_directory` creates directories recursively inside the trusted workspace and reports whether the target was newly created or already existed.
- `path_exists` reports whether a path exists and, when it does, whether it is a file, directory, other path kind, or symbolic link.

Why this matters:
- The package can expose a standard human-input contract without owning prompt UI, wait state, timeout policy, or answer persistence.
- HITL is therefore a package-visible capability with host-owned handling, not an in-package interactive approval loop.
- The filesystem trio gives models narrow, structured workspace primitives for discovery, directory creation, and existence checks without forcing a shell command for every routine task.
- Shell execution has some guardrails, but the executor still runs any available binary under the host process identity. There is no built-in allowlist, sandbox, or read-only permission gate for `shell_cmd`.

Read this with [[src-builtins]] for catalog shape, [[host-owned-ask-user-input]] for default runtime handling of human-input calls, [[approval-and-synthetic-tool-call-messages]] for pending artifacts versus synthetic tool calls, [[file-tool-contract-hardening]] for recent filesystem fixes, and [[shell-command-safeguards]] for detailed `shell_cmd` protections and limitations.
