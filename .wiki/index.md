---
title: "Project Wiki"
type: "index"
status: "active"
language: "default"
last_commit: "1de81d5a58a10893f61cdb80a530b070801318fc"
updated_at: "2026-05-15"
---

`llm-runtime` is a TypeScript package for building tool-using LLM workflows without forcing your app to own every low-level detail itself.

In plain terms, it gives you one package that can:
- talk to model providers such as OpenAI, Anthropic, Google, Azure, and Ollama
- expose built-in tools for file reads, search, shell commands, and human input
- connect extra tools through Model Context Protocol (MCP) servers and local skill files
- run a bounded loop that keeps working until there is a real answer, a real blocker, or a real need for user input

If you are new to the codebase, start with the pages below in this order:

1. [[environment-vs-per-call]] for the main ownership rule: what the package owns versus what your app still owns.
2. [[src-runtime]] for the main public API surface.
3. [[src-completion-loop]] for the "keep working until done" loop.
4. [[src-builtins]] for the built-in tools and their safety boundaries.
5. [[provider-adapters]] for provider-specific differences.

Core pages:
- [[environment-vs-per-call]] explains the package's main boundary: which work belongs to the runtime and which work still belongs to the host app.
- [[src-runtime]] explains how one call becomes a fully wired runtime with providers, tools, MCP servers, and skills.
- [[src-completion-loop]] explains the preferred agent-style loop and its default safety rules.
- [[src-runtime-complete-contract]] explains the public `complete(...)` / `streamComplete(...)` result shapes and how to resume after asking a human for input.
- [[public-types]] summarizes the main exported types without making you read every source file.
- [[system-prompt-schema]] explains how to build one stable system message that works across providers.
- [[web-search-across-providers]] explains how optional web search works across different providers.

Execution surfaces:
- [[src-builtins]] documents the built-in tool catalog and where the package draws the line between read-only inspection and side effects.
- [[src-builtin-executors]] shows what the built-in tools actually do at runtime, including the pending artifact returned when a human answer is required.
- [[src-mcp]] explains how MCP server config turns into callable tools and how those clients are cached.
- [[src-prompt-contracts]] explains the package-managed prompt blocks that the runtime adds to the first system message.
- [[src-provider-tool-names]] explains how tool names are rewritten safely for each provider and then mapped back.
- [[src-skills]] explains how skill directories are discovered and loaded.
- [[src-turn-loop]] explains the older compatibility entrypoint that now forwards to the newer completion-loop surface.
- [[src-tool-validation]] explains how malformed tool arguments are corrected or rejected in a structured way.
- [[provider-adapters]] compares the provider-specific request and response conversions.

Operational safeguards:
- [[shell-command-safeguards]] documents the real protections and the real limits of the built-in `shell_cmd` executor.

Quality and recent changes:
- [[testing-and-showcases]] summarizes how the package is tested, from unit tests to real-provider showcase runs.
- [[provider-adapters]] now covers provider-native web search, Gemini schema cleanup, and OpenAI-compatible request mapping across Azure, XAI, Ollama, and generic backends.
- [[action-execution-hardening]] captures the April 2026 fix that stopped narration-only false success in tool-capable turns.
- [[language-agnostic-continuation]] explains, in plain English, how the runtime checks whether work actually happened instead of trusting confident-sounding progress text.
- [[turn-loop-safety-and-lifecycle]] captures the April 2026 loop hardening pass: hard limits, trace data, synthetic tool-call marking, and public cleanup APIs.
- [[approval-and-synthetic-tool-call-messages]] explains the difference between a host-mediated human-input artifact and a runtime-generated synthetic tool-call message.
- [[src-completion-loop]] and [[src-runtime]] also cover the May 2026 public rename to `createRuntime(...)`, `complete(...)`, `runCompletionLoop(...)`, and `disposeRuntimeCaches()` while preserving deprecated compatibility aliases.

Coverage note: this wiki reflects the current May 2026 package shape, including the safer read-only built-in defaults, the single `ask_user_input` contract for human questions, the newer completion-loop and runtime-facade helpers, the shared prompt and provider-name helper modules, provider stop metadata, the legacy compatibility path in `src/turn-loop.ts`, and the Azure/Gemini presentation-style runners. Supporting docs under `docs/` and `.docs/` are included where they help explain behavior, but they are summarized rather than copied verbatim.
