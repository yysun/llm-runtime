---
title: "File Tool Contract Hardening"
type: "bug-fix"
status: "active"
language: "default"
source_paths:
  - ".docs/reqs/2026/05/18/req-file-tool-contract-hardening.md"
  - ".docs/done/2026/05/18/file-tool-contract-hardening.md"
  - "README.md"
  - "src/builtins.ts"
  - "src/builtin-executors.ts"
  - "src/tool-validation.ts"
  - "src/types.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-27"
---

The May 2026 file-tool hardening fixed drift between the documented structured workspace tools and their actual executor behavior.

The old risk was subtle: agents could be pushed back toward `shell_cmd` because the safer structured tools had inconsistent path scope, validation, hidden-file behavior, or path-kind reporting. The fix made the contract sharper instead of adding broader filesystem power.

Facts from source:
- `read_file` no longer falls back to skill roots. It stays scoped to the trusted working directory.
- `read_file` still paginates with `offset` and `limit`, but it no longer imposes a fixed hard line cap as public behavior.
- `read_file` and `write_file` now have schema requirements that match their executor requirements, and validation preserves the `path` alias for both.
- `list_files` and `search_files` hide dot-prefixed paths by default and include them only when `includeHidden: true` is passed.
- Non-hidden directories such as `node_modules` and `dist` are no longer silently hard-excluded.
- `path_exists` reports symlink presence separately, including dangling symlinks that exist but do not resolve to a file or directory.
- Focused tests in `tests/llm/runtime.test.ts` cover scope enforcement, hidden entry discovery, uncapped reads, write validation, directory creation, and symlink-aware existence checks.

The product consequence is straightforward: normal workspace discovery should use [[src-builtins]] file tools first. `shell_cmd` remains for explicit command execution and gaps in the structured surface, not routine file inspection.

Read this with [[src-builtin-executors]], [[src-tool-validation]], and [[shell-command-safeguards]].
