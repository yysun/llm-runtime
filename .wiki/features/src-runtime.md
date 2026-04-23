---
title: "Runtime API"
type: "feature"
status: "active"
source_paths:
  - "README.md"
  - "src/runtime.ts"
  - "src/index.ts"
  - "src/llm-config.ts"
  - "tests/llm/runtime-provider.test.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-04-23"
---

`src/runtime.ts` is the package's orchestration layer for `createLLMEnvironment(...)`, `generate(...)`, `stream(...)`, and tool resolution.

Facts from source:
- Explicit environments are passed through unchanged; otherwise the module builds cached provider, MCP, and skill registries keyed by a stable JSON string so repeated per-call use can reuse equivalent runtime dependencies.
- `resolveTools(...)` merges built-ins and extra/direct tools synchronously; `resolveToolsAsync(...)` adds MCP-discovered tools on top.
- Request-local `tools` override same-name resolved tools, but built-in name collisions are rejected before merge.
- `generate(...)` and `stream(...)` share the same environment and tool-resolution pipeline, then dispatch into provider-specific helpers from [[provider-adapters]]. OpenAI, Azure, XAI, generic OpenAI-compatible backends, and Ollama all route through the OpenAI-compatible adapter; Anthropic and Google keep their own adapter paths.
- `webSearch` is an explicit per-call option on `generate(...)` and `stream(...)`. `true` normalizes to an empty provider-default config, `false` disables it, and the runtime forwards it only when requested rather than enabling it implicitly for generic OpenAI-compatible backends.
- The module exports `disposeLLMEnvironment(...)` for explicit environment cleanup and `disposeLLMRuntimeCaches()` for cached convenience-path cleanup.
- Explicit-environment cleanup is ownership-aware: only MCP registries created by the runtime are shut down, while caller-injected registries remain caller-owned.
- The legacy test reset helper delegates to the same public cache-disposal path instead of owning separate shutdown logic.

Design boundary:
- This module owns runtime assembly and provider dispatch.
- It owns lifecycle cleanup only for runtime-created registries and caches.
- It does not own message persistence, queueing, transcript policy, or tool-loop state transitions; those remain in callers or in [[src-turn-loop]].

Read this after [[environment-vs-per-call]] when you need to understand how a single API call becomes a fully resolved runtime surface. For provider-specific search behavior, see [[web-search-across-providers]]. For the April 2026 cleanup boundary and public shutdown APIs, see [[turn-loop-safety-and-lifecycle]].
