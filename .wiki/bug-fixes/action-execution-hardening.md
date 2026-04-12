---
title: "Action Execution Hardening"
type: "bug-fix"
status: "active"
source_paths:
  - ".docs/req/2026/04/12/req-llm-action-execution-hardening.md"
  - ".docs/done/2026/04/12/llm-action-execution-hardening.md"
  - "src/turn-loop.ts"
  - "src/tool-validation.ts"
  - "tests/llm/turn-loop.test.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
updated_at: "2026-04-12"
---

Problem:
- Tool-capable turns could previously end in false success when a weak model replied with narration like "I will inspect the file" instead of emitting a real tool call or a verified answer.

What changed at `HEAD`:
- `src/turn-loop.ts` now distinguishes verified text, intent-only narration, non-progressing text, and tool-call responses.
- Hosts can enforce action-proof requirements through `requiresActionEvidence(...)`, override classification with `classifyTextResponse(...)`, and persist rejected narration through `onRejectedTextResponse(...)`.
- Rejected text retries are bounded separately from empty-text retries.
- `src/tool-validation.ts` now emits durable validation artifacts that callers can parse and feed back to the model for bounded self-correction.

Why it matters:
- A narrated future action is no longer treated as completed work.
- Validation failures remain explicit, structured, and recoverable.
- Direct-turn and continuation-turn paths now share the same integrity rule.

Verification lives in both `tests/llm/turn-loop.test.ts` and the deterministic e2e runner `tests/e2e/llm-turn-loop-hardening.ts`. For the runtime shape around this fix, read [[src-turn-loop]] and [[src-tool-validation]].