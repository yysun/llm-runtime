---
title: "Project Wiki"
type: "index"
status: "active"
last_commit: "91c475d37c06eb2d95f7753b4f500bfbca90d907"
updated_at: "2026-04-12"
---

`llm-runtime` is a TypeScript package that wraps provider calls, built-in tools, MCP integration, skill loading, and a host-owned turn loop behind one publishable runtime boundary.

Core pages:
- [[environment-vs-per-call]] explains the package's main ownership rule.
- [[src-runtime]] covers environment creation, cached convenience execution, and tool resolution.
- [[public-types]] summarizes the portable contracts exported from the package entrypoint.

Execution surfaces:
- [[src-builtins]] documents the built-in tool catalog and executor boundary.
- [[src-mcp]] covers MCP config normalization, client/tool caching, and namespaced tool exposure.
- [[src-skills]] covers ordered skill-root discovery and skill loading.
- [[src-turn-loop]] explains the host-agnostic loop and callback ownership model.
- [[src-tool-validation]] covers deterministic argument normalization and durable validation artifacts.
- [[provider-adapters]] compares the OpenAI-compatible, Anthropic, and Google adapters.

Quality and recent changes:
- [[testing-and-showcases]] summarizes unit coverage, real-provider showcases, and deterministic hardening e2e coverage.
- [[action-execution-hardening]] captures the April 2026 fix that prevents narration-only false success in tool-capable turns.

Coverage note: this bootstrap wiki focuses on the public API, major runtime modules, tests, and the latest bug fix. Tracked docs such as `docs/ideas.md` and `.docs/` artifacts are represented where they inform runtime behavior, but they are not yet split into separate note pages.