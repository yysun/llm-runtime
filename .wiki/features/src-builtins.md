---
title: "Built-In Tools"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "README.md"
  - ".docs/reqs/2026/04/24/req-human-input-choice-schema.md"
  - ".docs/reqs/2026/05/14/req-builtin-filesystem-tools.md"
  - ".docs/reqs/2026/05/18/req-file-tool-contract-hardening.md"
  - ".docs/done/2026/05/18/file-tool-contract-hardening.md"
  - ".docs/reqs/2026/05/26/req-host-owned-ask-user-input.md"
  - ".docs/done/2026/05/26/host-owned-ask-user-input.md"
  - ".docs/reqs/2026/05/28/req-host-owned-tool-calls.md"
  - "src/complete-defaults.ts"
  - "src/builtins.ts"
  - "src/builtin-executors.ts"
  - "src/human-input-contract.ts"
  - "src/tool-validation.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-28"
---

The package owns ten reserved built-in tool names: `shell_cmd`, `load_skill`, `ask_user_input`, `web_fetch`, `read_file`, `write_file`, `list_files`, `search_files`, `create_directory`, and `path_exists`.

In plain terms, these are the tools that ship with `llm-runtime` itself. Callers can enable or disable them, but they cannot redefine what those tool names mean.

Facts from source:
- `src/builtins.ts` defines stable descriptions and JSON-schema parameter contracts for every built-in.
- Selection accepts `true`, `false`, or an explicit per-tool map. Omitted selection defaults to `true`, so hosts get every package-owned built-in unless they disable or narrow the surface.
- There is no string `all` or `read-only` mode. A read-only host should spell out `load_skill`, `list_files`, `search_files`, `read_file`, and `path_exists`; a writing host should add only `create_directory` and `write_file` when needed; a command-running host should add `shell_cmd` only for command-specific work.
- `search_files` is the package-owned file-discovery primitive, while `create_directory` and `path_exists` cover narrow filesystem mutation and existence checks inside the trusted working directory.
- `search_files` replaced the older `grep` built-in name. Current unit coverage explicitly rejects `grep` as an unknown built-in selection key.
- `ask_user_input` is the only public human-input built-in on the current package surface. Its description and JSON schema are shared from `src/human-input-contract.ts` so the catalog and runtime-facade helpers stay aligned.
- The human-input schema requires `questions[]` with stable question ids and option ids. It supports `single-select`, `multiple-select`, and optional `allowSkip` for explicitly dismissible prompts.
- Default `resolveTools(...)` exposure includes every built-in when callers omit `builtIns`; callers use `builtIns: false` to disable all built-ins or a per-tool map to select a narrower surface.
- Package-managed completion defaults to every built-in through `src/complete-defaults.ts`.
- `ask_user_input` visibility is contract advertisement, not UI ownership. The default built-in has no package executor, so runtime completion returns `status: "tool_calls"` for the host unless the host supplies an executable `ask_user_input` tool.
- `read_file` and `write_file` both require `filePath` in the schema while validation preserves the `path` alias. `read_file` remains paginated through `offset` and `limit`, but the public contract no longer promises a fixed hard maximum line cap.
- `list_files` and `search_files` exclude dot-prefixed paths unless `includeHidden: true` is passed. They no longer hard-exclude ordinary directories such as `node_modules` or `dist`.
- `path_exists` is symlink-aware: it reports symlink presence separately from whether the symlink target resolves to a file or directory.
- Every executable built-in is wrapped with [[src-tool-validation]] before exposure.
- `src/builtin-executors.ts` keeps execution package-owned for executable built-ins: file and shell tools enforce a trusted working directory, and `load_skill` reads from the skill registry. It does not provide a package executor for `ask_user_input`.
- The `shell_cmd` contract itself is intentionally narrow: `command` is required, undeclared parameters are rejected, and the description says it should only be used when the user explicitly asked for command execution.
- The `shell_cmd` description now explicitly steers callers toward the structured workspace tools (`list_files`, `search_files`, `read_file`, `path_exists`, `create_directory`) for routine workspace inspection.

Important constraint:
- Application tools are additive only for normal built-ins. `ask_user_input` is the deliberate exception: hosts may provide an executable tool with that name because the product owns the actual human interaction.

Security note:
- `shell_cmd` has argument validation, scoped working-directory resolution, non-shell spawning, and time-bounded execution, but it is not a sandbox and does not maintain a command allowlist. See [[shell-command-safeguards]].

This page pairs with [[src-runtime]] for tool resolution behavior, [[src-builtin-executors]] for concrete executor behavior, [[src-tool-validation]] for malformed arguments, [[host-owned-ask-user-input]] for the human-input ownership boundary, [[file-tool-contract-hardening]] for recent filesystem contract fixes, and [[shell-command-safeguards]] for the concrete `shell_cmd` security posture.
