---
title: "Built-In Tools"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "README.md"
  - ".docs/reqs/2026/04/24/req-human-input-choice-schema.md"
  - ".docs/reqs/2026/05/14/req-builtin-filesystem-tools.md"
  - "src/builtins.ts"
  - "src/builtin-executors.ts"
  - "src/tool-validation.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-15"
---

The package owns twelve reserved built-in tool names: `shell_cmd`, `load_skill`, `human_intervention_request`, `ask_user_question`, `ask_user_input`, `web_fetch`, `read_file`, `write_file`, `list_files`, `search_files`, `create_directory`, and `path_exists`.

Facts from source:
- `src/builtins.ts` defines stable descriptions and JSON-schema parameter contracts for every built-in.
- Selection can be boolean or per-tool; the runtime supports normalization and intersection so a caller can narrow a broader baseline safely.
- `search_files` is the package-owned file-discovery primitive, while `create_directory` and `path_exists` cover narrow filesystem mutation and existence checks.
- `search_files` replaced the older `grep` built-in name. Current unit coverage explicitly rejects `grep` as an unknown built-in selection key.
- `ask_user_input` is the preferred public human-input name. `human_intervention_request` and `ask_user_question` are synchronized compatibility aliases that use the same structured schema and enablement behavior.
- The human-input schema requires `questions[]` with stable question ids and option ids. It supports `single-select`, `multiple-select`, and optional `allowSkip` for explicitly dismissible prompts.
- Every executable built-in is wrapped with [[src-tool-validation]] before exposure.
- `src/builtin-executors.ts` keeps execution package-owned: file and shell tools enforce a trusted working directory, `load_skill` reads from the skill registry, and HITL returns a pending artifact instead of calling a host adapter.
- The `shell_cmd` contract itself is intentionally narrow: `command` is required, undeclared parameters are rejected, and the description says it should only be used when the user explicitly asked for command execution.
- The `shell_cmd` description now explicitly steers callers toward the structured workspace tools (`list_files`, `search_files`, `read_file`, `path_exists`, `create_directory`) for routine workspace inspection.

Important constraint:
- Application tools are additive only. They can disable built-ins, but they cannot redefine reserved built-in names.

Security note:
- `shell_cmd` has argument validation, scoped working-directory resolution, non-shell spawning, and time-bounded execution, but it is not a sandbox and does not maintain a command allowlist. See [[shell-command-safeguards]].

This page pairs with [[src-runtime]] for tool resolution behavior, with [[src-builtin-executors]] for concrete executor behavior, with [[src-tool-validation]] for the correction and failure path when a model sends malformed arguments, and with [[shell-command-safeguards]] for the concrete `shell_cmd` security posture.