---
title: "Testing and Showcases"
type: "concept"
status: "active"
source_paths:
  - "package.json"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/mcp-runtime.test.ts"
  - "tests/llm/runtime-provider.test.ts"
  - "tests/llm/showcase.test.ts"
  - "tests/llm/turn-loop.test.ts"
  - "tests/e2e/llm-package-showcase.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
  - "tests/e2e/llm-turn-loop-showcase.ts"
updated_at: "2026-04-12"
---

The repository splits validation into deterministic unit tests and showcase-style end-to-end runners.

Facts from source:
- `npm test` runs `vitest` over `tests/llm`, covering runtime config, skill precedence, tool resolution, MCP integration, and turn-loop behavior.
- `tests/llm/mcp-runtime.test.ts` uses mocked MCP SDK clients to prove namespaced tool resolution and cache reuse without real processes or sockets.
- `tests/llm/turn-loop.test.ts` now covers hard-stop reasons, lifecycle hook ordering, synthetic tool-call marking, repeated-call suppression, timeout behavior, and package-managed model dispatch.
- `tests/llm/runtime.test.ts` and `tests/llm/mcp-runtime.test.ts` cover the new public cleanup APIs, including the rule that caller-owned registries are not disposed by runtime cleanup.
- `tests/e2e/llm-package-showcase.ts` is a real-provider runner that loads `.env`, creates a temporary workspace, wires a test MCP server, and drives real `generate(...)` / `stream(...)` flows.
- `tests/e2e/llm-turn-loop-hardening.ts` is deterministic: it uses scripted model responses plus real built-in tool execution to test recovery logic, hardening paths, and public cleanup semantics without live provider calls.

This mix makes the package easy to regression test while still preserving one realistic walkthrough path for integration verification. Related pages: [[src-turn-loop]], [[src-runtime]], [[src-mcp]], [[action-execution-hardening]], and [[turn-loop-safety-and-lifecycle]].