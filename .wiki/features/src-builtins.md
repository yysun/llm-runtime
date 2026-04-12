---
title: "Built-In Tools"
type: "feature"
status: "active"
source_paths:
  - "src/builtins.ts"
  - "src/builtin-executors.ts"
  - "src/tool-validation.ts"
updated_at: "2026-04-12"
---

The package owns eight reserved built-in tool names: `shell_cmd`, `load_skill`, `human_intervention_request`, `web_fetch`, `read_file`, `write_file`, `list_files`, and `grep`.

Facts from source:
- `src/builtins.ts` defines stable descriptions and JSON-schema parameter contracts for every built-in.
- Selection can be boolean or per-tool; the runtime supports normalization and intersection so a caller can narrow a broader baseline safely.
- Every executable built-in is wrapped with [[src-tool-validation]] before exposure.
- `src/builtin-executors.ts` keeps execution package-owned: file and shell tools enforce a trusted working directory, `load_skill` reads from the skill registry, and HITL returns a pending artifact instead of calling a host adapter.
- The `shell_cmd` contract itself is intentionally narrow: `command` is required, undeclared parameters are rejected, and the description says it should only be used when the user explicitly asked for command execution.

Important constraint:
- Application tools are additive only. They can disable built-ins, but they cannot redefine reserved built-in names.

Security note:
- `shell_cmd` has argument validation, scoped working-directory resolution, non-shell spawning, and time-bounded execution, but it is not a sandbox and does not maintain a command allowlist. See [[shell-command-safeguards]].

This page pairs with [[src-runtime]] for tool resolution behavior, with [[src-builtin-executors]] for concrete executor behavior, with [[src-tool-validation]] for the correction and failure path when a model sends malformed arguments, and with [[shell-command-safeguards]] for the concrete `shell_cmd` security posture.