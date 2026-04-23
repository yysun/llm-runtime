---
title: "Testing and Showcases"
type: "concept"
status: "active"
source_paths:
  - "package.json"
  - "README.md"
  - "tests/llm/anthropic-direct.test.ts"
  - "tests/llm/google-direct.test.ts"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/mcp-runtime.test.ts"
  - "tests/llm/openai-direct.test.ts"
  - "tests/llm/runtime-provider.test.ts"
  - "tests/llm/showcase.test.ts"
  - "tests/llm/turn-loop.test.ts"
  - "tests/e2e/e2e-azure.ts"
  - "tests/e2e/e2e-gemini.ts"
  - "tests/e2e/llm-package-showcase.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
  - "tests/e2e/llm-turn-loop-showcase.ts"
  - "tests/e2e/support/llm-provider-e2e-support.ts"
updated_at: "2026-04-23"
---

The repository splits validation into deterministic unit tests and showcase-style end-to-end runners.

Facts from source:
- `npm test` runs `vitest` over `tests/llm`, covering runtime config, skill precedence, tool resolution, MCP integration, provider dispatch, and turn-loop behavior.
- Adapter-focused unit suites now validate provider request mapping directly: `tests/llm/openai-direct.test.ts` covers `reasoning_effort`, OpenAI/Azure `web_search_options`, and normalized tool-call responses; `tests/llm/anthropic-direct.test.ts` proves Anthropic web search is added as a provider-side server tool and that server blocks do not leak into host tool calls; `tests/llm/google-direct.test.ts` covers Google Search grounding plus Gemini-safe schema dereferencing and field stripping.
- `tests/llm/runtime-provider.test.ts` proves the runtime forwards explicit `webSearch` only when requested, including OpenAI, Azure, Gemini, Anthropic, XAI, `openai-compatible`, and Ollama dispatch paths.
- `tests/llm/mcp-runtime.test.ts` uses mocked MCP SDK clients to prove namespaced tool resolution, cache reuse, public cleanup, fail-fast stdio validation, and URL-only `streamable-http` transport defaults without real processes or sockets.
- `tests/llm/turn-loop.test.ts` now covers hard-stop reasons, lifecycle hook ordering, synthetic tool-call marking, repeated-call suppression, timeout behavior, and package-managed model dispatch.
- `tests/llm/runtime.test.ts` and `tests/llm/mcp-runtime.test.ts` cover the public cleanup APIs, including the rule that caller-owned registries are not disposed by runtime cleanup.
- `tests/e2e/llm-package-showcase.ts` is a real-provider runner that loads `.env`, creates a temporary workspace, wires a test MCP server, and drives real `generate(...)` / `stream(...)` flows.
- `tests/e2e/e2e-azure.ts` and `tests/e2e/e2e-gemini.ts` add provider-specific live suites on top of a shared harness in `tests/e2e/support/llm-provider-e2e-support.ts`. That harness supports `--dry-run`, provisions a temporary workspace, resolves built-ins plus MCP plus skills, and asserts exact final output lines, required tool usage, permission-blocked writes, and visible stream chunks.
- `tests/e2e/llm-turn-loop-hardening.ts` is deterministic: it uses scripted model responses plus real built-in tool execution to test recovery logic, hardening paths, and public cleanup semantics without live provider calls.

This mix keeps the package regression-friendly while preserving both provider-specific live verification and one realistic walkthrough path for integration debugging. Related pages: [[src-turn-loop]], [[src-runtime]], [[src-mcp]], [[provider-adapters]], [[web-search-across-providers]], [[action-execution-hardening]], and [[turn-loop-safety-and-lifecycle]].
