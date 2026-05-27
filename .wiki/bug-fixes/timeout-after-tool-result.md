---
title: "Timeout After Tool Result"
type: "bug-fix"
status: "active"
language: "default"
source_paths:
  - "src/completion-loop.ts"
  - "tests/llm/turn-loop.test.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
updated_at: "2026-05-27"
---

The loop now handles one ugly edge case more deliberately: the model can time out after a tool already completed real work.

The old behavior treated that as a plain timeout. That was technically honest, but operationally weak: the transcript already contained completed tool results, yet the caller got a terminal timeout branch with no final assistant-facing explanation.

Facts from source:
- `src/completion-loop.ts` exports `DEFAULT_TIMEOUT_AFTER_TOOL_RESULT_MESSAGE`.
- When wall-clock timeout hits after observed action evidence and an existing tool result, the loop can synthesize a text response with provider stop reason `timeout_after_tool_result`.
- The result reason becomes `text_response`, because the loop is returning an explicit diagnostic assistant message.
- Stop metadata still records `timedOutDuringIteration`, so telemetry can distinguish this diagnostic path from a normal final answer.
- The behavior is covered in `tests/llm/turn-loop.test.ts`.
- `tests/e2e/llm-turn-loop-hardening.ts` adds a deterministic scenario where `create_directory` succeeds and the next model turn never returns.

This is not a claim that the user task succeeded. It is a safer failure shape: completed tool evidence stays in the conversation, and the host gets a readable final diagnostic instead of a bare timeout.

Read this with [[src-completion-loop]], [[turn-loop-safety-and-lifecycle]], and [[testing-and-showcases]].
