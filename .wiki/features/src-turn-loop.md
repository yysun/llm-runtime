---
title: "Turn Loop Compatibility Path"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "src/index.ts"
  - "src/turn-loop.ts"
  - "src/completion-loop.ts"
  - ".docs/done/2026/05/15/runtime-api-rename.md"
  - ".docs/reqs/2026/05/14/req-natural-language-continuation.md"
  - ".docs/plans/2026/05/14/plan-natural-language-continuation.md"
  - "tests/llm/turn-loop.test.ts"
  - "README.md"
updated_at: "2026-05-15"
---

`src/turn-loop.ts` is now a compatibility file. The canonical implementation lives in [[src-completion-loop]], while this path re-exports the same surface so older imports keep working.

Facts from source:
- The legacy names `runTurnLoop(...)`, `respondWithTools(...)`, `RunTurnLoopOptions`, and `RunTurnLoopResult` remain exported as deprecated aliases of `runCompletionLoop(...)`, `complete(...)`, `RunCompletionLoopOptions`, and `RunCompletionLoopResult`.
- The root entrypoint continues to export both the preferred and deprecated names, so existing callers can upgrade incrementally instead of rewriting imports all at once.
- Because the file re-exports the canonical implementation, older import paths still see the same terminal reasons, lifecycle hook types, trace summaries, control-tool outputs, and plain-text intent normalization behavior documented in [[src-completion-loop]].
- README examples and focused tests now use the preferred completion-loop names, while alias coverage remains in place to prevent accidental breakage.

Use this page when you need to understand the backward-compatibility contract for older path or symbol names. For the actual loop behavior, defaults, and control-tool semantics, read [[src-completion-loop]]. Related pages: [[action-execution-hardening]], [[language-agnostic-continuation]], [[turn-loop-safety-and-lifecycle]], [[approval-and-synthetic-tool-call-messages]], and [[src-tool-validation]].