---
title: "Testing and Showcases"
type: "concept"
status: "active"
source_paths:
  - "package.json"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/mcp-runtime.test.ts"
  - "tests/llm/turn-loop.test.ts"
  - "tests/e2e/llm-package-showcase.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
updated_at: "2026-04-12"
---

The repository splits validation into deterministic unit tests and showcase-style end-to-end runners.

Facts from source:
- `npm test` runs `vitest` over `tests/llm`, covering runtime config, skill precedence, tool resolution, MCP integration, and turn-loop behavior.
- `tests/llm/mcp-runtime.test.ts` uses mocked MCP SDK clients to prove namespaced tool resolution and cache reuse without real processes or sockets.
- `tests/llm/turn-loop.test.ts` exercises plain text completion, synthesized plain-text tool intent, and narration rejection.
- `tests/e2e/llm-package-showcase.ts` is a real-provider runner that loads `.env`, creates a temporary workspace, wires a test MCP server, and drives real `generate(...)` / `stream(...)` flows.
- `tests/e2e/llm-turn-loop-hardening.ts` is deterministic: it uses scripted model responses plus real built-in tool execution to test recovery logic without live provider calls.

This mix makes the package easy to regression test while still preserving one realistic walkthrough path for integration verification. Related pages: [[src-turn-loop]], [[src-mcp]], and [[action-execution-hardening]].