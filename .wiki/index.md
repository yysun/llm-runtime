---
title: "Project Wiki"
type: "index"
status: "active"
language: "default"
last_commit: "9b42b94acb30a777c1eb58e8342c6f07b947d11e"
updated_at: "2026-05-15"
---

`llm-runtime` is a TypeScript package that wraps provider calls, built-in tools, MCP integration, skill loading, and a host-owned turn loop behind one publishable runtime boundary.

Core pages:
- [[environment-vs-per-call]] explains the package's main ownership rule.
- [[src-runtime]] covers environment creation, cached convenience execution, and tool resolution.
- [[src-completion-loop]] covers the preferred completion-loop API, package-owned defaults, and deterministic control-tool stops.
- [[public-types]] summarizes the portable contracts exported from the package entrypoint.
- [[system-prompt-schema]] explains how callers should assemble one stable system message from client instructions, AGENTS.md content, caller-owned tool policy, and runtime-injected tool guidance.
- [[web-search-across-providers]] explains the new per-call cross-provider web-search surface.

Execution surfaces:
- [[src-builtins]] documents the built-in tool catalog and executor boundary.
- [[src-builtin-executors]] covers the concrete built-in implementations, including the HITL pending approval artifact.
- [[src-mcp]] covers MCP config normalization, client/tool caching, and namespaced tool exposure.
- [[src-skills]] covers ordered skill-root discovery and skill loading.
- [[src-turn-loop]] explains the legacy compatibility path that now re-exports the completion-loop surface.
- [[src-tool-validation]] covers deterministic argument normalization and durable validation artifacts.
- [[provider-adapters]] compares the OpenAI-compatible, Anthropic, and Google adapters.

Operational safeguards:
- [[shell-command-safeguards]] documents the actual runtime protections and current limits of the builtin `shell_cmd` executor.

Quality and recent changes:
- [[testing-and-showcases]] summarizes unit coverage, real-provider showcases, and deterministic hardening e2e coverage.
- [[provider-adapters]] now covers provider-native web search, Gemini schema normalization, and OpenAI-compatible request mapping across Azure, XAI, Ollama, and generic backends.
- [[action-execution-hardening]] captures the April 2026 fix that prevents narration-only false success in tool-capable turns.
- [[language-agnostic-continuation]] explains, in layman's terms, how the runtime decides whether work actually happened instead of trusting English progress narration.
- [[turn-loop-safety-and-lifecycle]] captures the April 2026 expansion that added hard loop limits, trace metadata, synthetic tool-call marking, and public cleanup APIs.
- [[approval-and-synthetic-tool-call-messages]] explains the difference between host-mediated HITL approval artifacts and runtime-generated synthetic tool-call messages.
- [[src-completion-loop]] and [[src-runtime]] now also cover the May 2026 public rename to `createRuntime(...)`, `complete(...)`, `runCompletionLoop(...)`, and `disposeRuntimeCaches()` while preserving deprecated compatibility aliases.

Coverage note: this ingest reflects the May 2026 filesystem built-in surface (`search_files`, `create_directory`, `path_exists`), the synchronized HITL alias set (`ask_user_input`, `ask_user_question`, `human_intervention_request`), the package-owned `complete(...)` continuation defaults, the compatibility `src/turn-loop.ts` path, and the presentation-oriented Azure/Gemini completion-loop runners. Tracked docs such as `docs/ideas.md` and the recent `.docs/` implementation artifacts are represented where they inform runtime behavior, but they are still summarized rather than mirrored verbatim.
