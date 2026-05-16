---
title: "Runtime API"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "README.md"
  - ".docs/done/2026/05/15/runtime-api-rename.md"
  - ".docs/done/2026/05/15/runtime-hardening-followups.md"
  - ".docs/done/2026/05/15/runtime-safety-hardening.md"
  - "src/runtime.ts"
  - "src/complete-defaults.ts"
  - "src/index.ts"
  - "src/prompt-contracts.ts"
  - "src/runtime-complete-contract.ts"
  - "src/types.ts"
  - "src/llm-config.ts"
  - "tests/llm/runtime-provider.test.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-15"
---

`src/runtime.ts` is the main entry point when you want the package to wire providers, tools, and shared runtime state together for you.

In plain terms, this is the layer that turns one request plus your configured dependencies into a ready-to-use runtime object. `createRuntime(...)` is now the preferred constructor; `createLLMEnvironment(...)` remains as a deprecated alias.

Facts from source:
- `createRuntime(...)` assembles provider config, MCP, and skill registries into one `LLMRuntime` object with bound `generate(...)`, `complete(...)`, `streamComplete(...)`, `resolveTools(...)`, `executeToolCall(...)`, `executeToolCalls(...)`, and `dispose()` methods.
- Runtime-bound calls automatically inject the runtime as `environment`, so harness code can keep stable provider, MCP, and skill dependencies without rebuilding them per request.
- Explicit environments are still passed through unchanged; otherwise the module builds cached provider, MCP, and skill registries keyed by a stable JSON string so repeated per-call use can reuse equivalent runtime dependencies.
- `resolveTools(...)` merges built-ins and extra/direct tools synchronously; `resolveToolsAsync(...)` adds MCP-discovered tools on top.
- Request-local `tools` override same-name resolved tools, but built-in name collisions are rejected before merge.
- `generate(...)` and `stream(...)` share the same environment and tool-resolution pipeline, then dispatch into provider-specific helpers from [[provider-adapters]]. OpenAI, Azure, XAI, generic OpenAI-compatible backends, and Ollama all route through the OpenAI-compatible adapter; Anthropic and Google keep their own adapter paths.
- `runtime.complete(...)` and `runtime.streamComplete(...)` adapt [[src-completion-loop]] into the stable runtime-facade result and event shapes documented in [[src-runtime-complete-contract]]. On the package-managed `modelRequest` path they fill in `modelRequest.environment` with the same runtime unless the caller already supplied one.
- The runtime facade keeps stricter defaults than the standalone loop helper: when callers do not override it, `runtime.complete(...)` uses `defaultTextResponseMode: 'require_tool_result'` and forwards explicit `maxConsecutiveToolTurns` and `maxWallTimeMs` bounds into the hardened loop.
- When `builtIns` is omitted for runtime-facade completion, the runtime defaults to the package-owned completion baseline from `src/complete-defaults.ts`: read-only workspace built-ins plus `ask_user_input`.
- Before dispatch, the runtime can inject package-owned tool guidance into the first system message. Caller-owned system content, including any embedded AGENTS.md instructions or caller-defined tool policy, should therefore be assembled into one leading system block before the runtime appends its own guidance.
- Managed prompt sections are inserted through `src/prompt-contracts.ts`, which strips and replaces the runtime-owned tagged block rather than stacking duplicates across retries or repeated runtime calls.
- `webSearch` is an explicit per-call option on `generate(...)` and `stream(...)`. `true` normalizes to an empty provider-default config, `false` disables it, and the runtime forwards it only when requested rather than enabling it implicitly for generic OpenAI-compatible backends.
- Preferred cleanup is now split between `runtime.dispose()` for an explicit runtime and `disposeRuntimeCaches()` for cached convenience-path cleanup. `disposeLLMEnvironment(...)` and `disposeLLMRuntimeCaches()` remain as deprecated aliases.
- Explicit-environment cleanup is ownership-aware: only MCP registries created by the runtime are shut down, while caller-injected registries remain caller-owned.
- The legacy test reset helper delegates to the same public cache-disposal path instead of owning separate shutdown logic.

Design boundary:
- This module owns runtime assembly and provider dispatch.
- It owns lifecycle cleanup only for runtime-created registries and caches.
- It does not own message persistence, queueing, transcript policy, or completion-loop state transitions; those remain in callers or in [[src-completion-loop]].

Read this after [[environment-vs-per-call]] when you need to understand how a single API call becomes a fully resolved runtime surface. For the preferred iterative API built on top of the runtime facade, see [[src-completion-loop]]. For the runtime-facade completion result and stream event shapes, see [[src-runtime-complete-contract]]. For provider-specific search behavior, see [[web-search-across-providers]]. For the recommended caller-facing layout of system prompt sections, see [[system-prompt-schema]]. For the April 2026 cleanup boundary and public shutdown APIs, see [[turn-loop-safety-and-lifecycle]].
