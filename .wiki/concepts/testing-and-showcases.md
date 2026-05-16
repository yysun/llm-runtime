---
title: "Testing and Showcases"
type: "concept"
status: "active"
language: "default"
source_paths:
  - "package.json"
  - "README.md"
  - ".docs/done/2026/05/15/runtime-api-rename.md"
  - "tests/llm/anthropic-direct.test.ts"
  - "tests/llm/google-direct.test.ts"
  - "tests/llm/provider-tool-names.test.ts"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/mcp-runtime.test.ts"
  - "tests/llm/mock-llm-scenario.test-support.ts"
  - "tests/llm/openai-direct.test.ts"
  - "tests/llm/runtime-provider.test.ts"
  - "tests/llm/showcase.test.ts"
  - "tests/llm/tool-validation.test.ts"
  - "tests/llm/turn-loop.test.ts"
  - "tests/e2e/e2e-azure.ts"
  - "tests/e2e/e2e-gemini.ts"
  - "tests/e2e/llm-package-showcase.ts"
  - "tests/e2e/llm-turn-loop-azure-presentation.ts"
  - "tests/e2e/llm-turn-loop-gemini-presentation.ts"
  - "tests/e2e/llm-turn-loop-hardening.ts"
  - "tests/e2e/llm-turn-loop-showcase.ts"
  - "tests/e2e/support/llm-provider-e2e-support.ts"
updated_at: "2026-05-15"
---

The repository splits validation into deterministic unit tests and showcase-style end-to-end runners.

Facts from source:
- `npm test` runs `vitest` over `tests/llm`, covering runtime config, skill precedence, tool resolution, MCP integration, provider dispatch, and turn-loop behavior.
- Adapter-focused unit suites validate provider request mapping directly: `tests/llm/openai-direct.test.ts` covers `reasoning_effort`, OpenAI/Azure `web_search_options`, normalized tool-call responses, and OpenAI-compatible finish-reason metadata; `tests/llm/anthropic-direct.test.ts` proves Anthropic web search is added as a provider-side server tool, that server blocks do not leak into host tool calls, and that `stop_reason` is preserved; `tests/llm/google-direct.test.ts` covers Google Search grounding, Gemini-safe schema dereferencing and field stripping, and additive `finishReason` preservation.
- `tests/llm/provider-tool-names.test.ts` isolates the shared provider tool-name translator so collisions, reserved names, and long tool names stay reversible across adapters.
- `tests/llm/runtime-provider.test.ts` proves the runtime forwards explicit `webSearch` only when requested, including OpenAI, Azure, Gemini, Anthropic, XAI, `openai-compatible`, and Ollama dispatch paths.
- `tests/llm/mcp-runtime.test.ts` uses mocked MCP SDK clients to prove namespaced tool resolution, cache reuse, public cleanup, fail-fast stdio validation, and URL-only `streamable-http` transport defaults without real processes or sockets.
- `tests/llm/turn-loop.test.ts` now covers hard-stop reasons, lifecycle hook ordering, synthetic tool-call marking, repeated-call suppression, timeout behavior, package-managed model dispatch, agent control-tool stops (`final_answer`, `need_user_input`, `blocked`), the permissive standalone `complete(...)` default, strict `require_tool_result` opt-in, action-evidence separation, and the reusable scripted mock-scenario helper used for hardened regression cases.
- `tests/llm/runtime.test.ts` covers the runtime facade directly with temporary workspaces, including `createRuntime(...)`, `disposeRuntimeCaches()`, `streamComplete(...)`, runtime forwarding of `maxConsecutiveToolTurns` and `maxWallTimeMs`, deterministic `search_files` results, idempotent `create_directory`, `path_exists`, read-only built-in defaults, the canonical `ask_user_input` schema, and explicit rejection of the removed `grep` built-in name.
- `tests/llm/runtime.test.ts` and `tests/llm/mcp-runtime.test.ts` also cover the public cleanup APIs, including the rule that caller-owned registries are not disposed by runtime cleanup.
- `tests/llm/tool-validation.test.ts` isolates parameter-shape correction and validation failures so malformed tool arguments surface durable artifacts instead of silent coercion.
- `tests/llm/showcase.test.ts` keeps the README-style flows aligned with the preferred public names while preserving alias coverage, so the documentation examples and published surface drift together instead of independently.
- `tests/e2e/llm-package-showcase.ts` is a real-provider runner that loads `.env`, creates a temporary workspace, wires a test MCP server, and drives real `generate(...)` / `stream(...)` flows.
- `tests/e2e/e2e-azure.ts` and `tests/e2e/e2e-gemini.ts` add provider-specific live suites on top of a shared harness in `tests/e2e/support/llm-provider-e2e-support.ts`. That harness supports `--dry-run`, provisions a temporary workspace, resolves built-ins plus MCP plus skills, and asserts exact final output lines, required tool usage, permission-blocked writes, and visible stream chunks.
- `tests/e2e/llm-turn-loop-azure-presentation.ts` and `tests/e2e/llm-turn-loop-gemini-presentation.ts` are presentation-oriented runners that force the model to load the `presentation` skill and read `README.md` plus `package.json` before drafting a five-slide storyboard through the completion-loop API.
- `tests/e2e/llm-turn-loop-hardening.ts` is deterministic: it uses scripted model responses plus real built-in tool execution to test recovery logic, hardening paths, and public cleanup semantics without live provider calls.

This mix keeps the package regression-friendly while preserving both provider-specific live verification and realistic walkthrough paths for integration debugging and presentation generation. Related pages: [[src-completion-loop]], [[src-turn-loop]], [[src-runtime]], [[src-mcp]], [[provider-adapters]], [[web-search-across-providers]], [[action-execution-hardening]], [[language-agnostic-continuation]], and [[turn-loop-safety-and-lifecycle]].
