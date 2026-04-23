---
title: "Project Wiki"
type: "index"
status: "active"
last_commit: "29033dd339e5e9df5249fddab7aebf82abd32fb9"
updated_at: "2026-04-23"
---

`llm-runtime` is a TypeScript package that wraps provider calls, built-in tools, MCP integration, skill loading, and a host-owned turn loop behind one publishable runtime boundary.

Core pages:
- [[environment-vs-per-call]] explains the package's main ownership rule.
- [[src-runtime]] covers environment creation, cached convenience execution, and tool resolution.
- [[public-types]] summarizes the portable contracts exported from the package entrypoint.
- [[web-search-across-providers]] explains the new per-call cross-provider web-search surface.

Execution surfaces:
- [[src-builtins]] documents the built-in tool catalog and executor boundary.
- [[src-builtin-executors]] covers the concrete built-in implementations, including the HITL pending approval artifact.
- [[src-mcp]] covers MCP config normalization, client/tool caching, and namespaced tool exposure.
- [[src-skills]] covers ordered skill-root discovery and skill loading.
- [[src-turn-loop]] explains the host-agnostic loop and callback ownership model.
- [[src-tool-validation]] covers deterministic argument normalization and durable validation artifacts.
- [[provider-adapters]] compares the OpenAI-compatible, Anthropic, and Google adapters.

Operational safeguards:
- [[shell-command-safeguards]] documents the actual runtime protections and current limits of the builtin `shell_cmd` executor.

Quality and recent changes:
- [[testing-and-showcases]] summarizes unit coverage, real-provider showcases, and deterministic hardening e2e coverage.
- [[provider-adapters]] now covers provider-native web search, Gemini schema normalization, and OpenAI-compatible request mapping across Azure, XAI, Ollama, and generic backends.
- [[action-execution-hardening]] captures the April 2026 fix that prevents narration-only false success in tool-capable turns.
- [[turn-loop-safety-and-lifecycle]] captures the April 2026 expansion that added hard loop limits, trace metadata, synthetic tool-call marking, and public cleanup APIs.
- [[approval-and-synthetic-tool-call-messages]] explains the difference between host-mediated HITL approval artifacts and runtime-generated synthetic tool-call messages.

Coverage note: this ingest now covers the public API, runtime/provider adapter surfaces, provider-specific web search behavior, MCP transport defaults, and both mocked and live provider verification. Tracked docs such as `docs/ideas.md` and the recent `.docs/` web-search artifacts are represented where they inform runtime behavior, but they are still summarized rather than mirrored verbatim.
