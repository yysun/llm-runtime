---
title: "Turn Loop"
type: "feature"
status: "active"
source_paths:
  - "src/turn-loop.ts"
  - "tests/llm/turn-loop.test.ts"
  - "README.md"
updated_at: "2026-04-12"
---

`runTurnLoop(...)` is a host-agnostic model and tool loop. The package owns repetition and response classification; the host owns state, transcript shape, tool execution, and persistence.

Facts from source:
- Callers can supply either `modelRequest` to reuse package `generate(...)` / `stream(...)` or `callModel` to invoke the model themselves.
- `buildMessages(...)` rebuilds prompt state each iteration and can receive a transient recovery instruction.
- Plain-text tool intent normalization is optional and bounded through `parsePlainTextToolIntent(...)`.
- Text responses may be accepted, retried, or rejected based on `requiresActionEvidence(...)` and `classifyTextResponse(...)`.
- The loop tracks both empty-text retries and rejected-text retries, returning terminal reasons such as `text_response`, `tool_calls_response`, `rejected_text_response`, and `empty_text_stop`.

April 2026 added hardening so intent-only narration is not silently accepted on tool-capable turns. See [[action-execution-hardening]] and [[src-tool-validation]] for the two recovery paths the host can use.