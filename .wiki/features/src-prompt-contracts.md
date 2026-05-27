---
title: "Managed Prompt Contracts"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "src/prompt-contracts.ts"
  - "src/completion-loop.ts"
  - "src/runtime.ts"
  - ".docs/reqs/2026/05/26/req-host-owned-ask-user-input.md"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/turn-loop.test.ts"
updated_at: "2026-05-27"
---

`src/prompt-contracts.ts` owns the reusable prompt snippets that the package adds to the first system message.

In plain terms, this file keeps the runtime's own instructions in one place so `generate(...)`, `complete(...)`, and related helpers all inject the same wording instead of drifting apart.

Facts from source:
- The file defines three reusable prompt fragments: the agent run-loop contract, the human-intervention hint for `ask_user_input`, and the workspace-tool hint for structured file tools.
- `buildManagedSystemPrompt(...)` composes whichever sections the caller requests, while `upsertManagedSystemPrompt(...)` inserts them into the first system message.
- The injected block is wrapped in `<llm-runtime-loop-contract>...</llm-runtime-loop-contract>`, so the helper can strip and replace prior package-owned guidance without disturbing caller-owned system text.
- `containsAgentRunLoopSystemPrompt(...)` lets runtime code detect whether the run-loop contract is already present before deciding how much additional guidance to add.
- The human-intervention hint says to use `ask_user_input` only for required human decisions, not as a substitute for safe read-only lookup, search, or inspection.
- The agent run-loop prompt now makes the same distinction: search broadly first when ambiguity can be resolved safely, and use a user-input tool only when the missing input cannot be discovered or the next step needs a human decision.

Why this matters:
- Callers can keep one stable system message across providers while still letting the package add runtime-owned guidance deterministically.
- Retries and repeated runtime calls do not accumulate duplicate package instructions.
- The wording for human-input and workspace-tool behavior stays shared between the standalone completion loop and the runtime facade instead of drifting across modules.

Read this with [[system-prompt-schema]] for caller-facing layout guidance, [[src-completion-loop]] for the run-loop contract, and [[host-owned-ask-user-input]] for the human-input boundary these prompts support.
