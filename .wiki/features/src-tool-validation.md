---
title: "Tool Validation"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "src/tool-validation.ts"
  - "src/types.ts"
  - "tests/llm/runtime.test.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
updated_at: "2026-05-15"
---

`src/tool-validation.ts` checks tool arguments before any built-in or Model Context Protocol (MCP)-backed tool runs.

In plain terms, this is the package's safety gate for tool inputs: it fixes a few common model mistakes, rejects unsupported fields, and returns a structured error artifact when the arguments are still wrong.

Facts from source:
- Validation checks required parameters, unknown keys, and simple primitive types from the tool schema.
- The module also applies bounded corrections for known alias and formatting mistakes before execution.
- Current built-in alias fixes include `path -> filePath` for `read_file`, `directory -> path` for `list_files`, `search_files`, and `create_directory`, `query -> pattern` for `search_files`, and `filePath -> path` for `path_exists`.
- `web_fetch` also accepts `uri` or `href` as aliases for `url`, while `shell_cmd` strips caller-supplied working-directory fields so execution stays package-scoped.
- Scalar-to-array coercion and numeric-string conversion still apply where the schema allows them.
- Unknown parameters are rejected when `additionalProperties` is false.
- Validation failures produce a durable JSON artifact with `errorType: "tool_parameter_validation_failed"`, issue details, and any applied corrections.
- Helpers exist to create, parse, and detect these artifacts, plus a default recovery instruction string for the next turn.

This page is central to the package's reliability model: malformed tool calls become explicit evidence that the host can persist and feed back into [[src-turn-loop]] instead of collapsing into ambiguous free-form text.