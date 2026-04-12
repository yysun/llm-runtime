---
title: "Tool Validation"
type: "feature"
status: "active"
source_paths:
  - "src/tool-validation.ts"
  - "src/types.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
updated_at: "2026-04-12"
---

`src/tool-validation.ts` enforces deterministic guardrails before any built-in or MCP-backed tool executes.

Facts from source:
- Validation checks required parameters, unknown keys, and simple primitive types from the tool schema.
- The module also applies bounded corrections for known alias and formatting mistakes such as `path -> filePath`, `directory -> directoryPath`, scalar-to-array coercion, and numeric string conversion.
- Unknown parameters are rejected when `additionalProperties` is false.
- Validation failures produce a durable JSON artifact with `errorType: "tool_parameter_validation_failed"`, issue details, and any applied corrections.
- Helpers exist to create, parse, and detect these artifacts, plus a default recovery instruction string for the next turn.

This page is central to the package's reliability model: malformed tool calls become explicit evidence that the host can persist and feed back into [[src-turn-loop]] instead of collapsing into ambiguous free-form text.