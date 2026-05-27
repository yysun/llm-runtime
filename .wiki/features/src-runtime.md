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
  - ".docs/reqs/2026/05/27/req-harden-completion-loop.md"
  - ".docs/done/2026/05/27/harden-completion-loop.md"
  - ".docs/done/2026/05/27/skill-root-file-tools.md"
  - ".docs/reqs/2026/05/26/req-host-owned-ask-user-input.md"
  - ".docs/done/2026/05/26/host-owned-ask-user-input.md"
  - "src/runtime.ts"
  - "src/complete-defaults.ts"
  - "src/index.ts"
  - "src/prompt-contracts.ts"
  - "src/runtime-complete-contract.ts"
  - "src/types.ts"
  - "src/llm-config.ts"
  - "tests/llm/runtime-provider.test.ts"
  - "tests/llm/runtime.test.ts"
updated_at: "2026-05-27"
---

`src/runtime.ts` is the main entry point when you want the package to wire providers, tools, and shared runtime state together for you.

In plain terms, this is the layer that turns one request plus your configured dependencies into a ready-to-use runtime object. `createRuntime(...)` is the public constructor exported from the root entrypoint.

Facts from source:
- `createRuntime(...)` assembles provider config, MCP, and skill registries into one `LLMRuntime` object with bound `generate(...)`, `complete(...)`, `streamComplete(...)`, `resolveTools(...)`, `executeToolCall(...)`, `executeToolCalls(...)`, and `dispose()` methods.
- Runtime-bound calls automatically inject the runtime as `environment`, so harness code can keep stable provider, MCP, and skill dependencies without rebuilding them per request.
- Explicit environments are still passed through unchanged; otherwise the module builds cached provider, MCP, and skill registries keyed by a stable JSON string so repeated per-call use can reuse equivalent runtime dependencies.
- `resolveTools(...)` merges built-ins and extra/direct tools synchronously; `resolveToolsAsync(...)` adds MCP-discovered tools on top.
- Request-local `tools` override same-name resolved tools, but built-in name collisions are rejected before merge.
- `ask_user_input` is the exception to the normal built-in collision rule. Hosts may provide it as an executable direct or extra tool because the host owns the actual user interaction.
- `generate(...)` and `stream(...)` share the same environment and tool-resolution pipeline, then dispatch into provider-specific helpers from [[provider-adapters]]. OpenAI, Azure, XAI, generic OpenAI-compatible backends, and Ollama all route through the OpenAI-compatible adapter; Anthropic and Google keep their own adapter paths.
- The root entrypoint exports only `generate(...)`, `complete(...)`, `streamComplete(...)`, `createRuntime(...)`, and a compact type set. Lower-level helpers in this file, including standalone tool resolution and cache cleanup functions, are internal extension points rather than root public API.
- `runtime.complete(...)` and `runtime.streamComplete(...)` adapt [[src-completion-loop]] into the stable runtime-facade result and event shapes documented in [[src-runtime-complete-contract]].
- The runtime facade now treats control-tool termination as the only supported agentic stop protocol. Plain assistant narration is retried or rejected; final answers should arrive through `final_answer`, missing user decisions through `need_user_input`, and hard blockers through `blocked`.
- `runtime.streamComplete(...)` now emits provider text and reasoning deltas when adapters supply them, in addition to lifecycle events.
- The runtime facade forwards explicit `maxConsecutiveToolTurns`, `maxWallTimeMs`, repeated-tool-call guard, rejected-text retry, and empty-text retry bounds into the hardened loop.
- When `builtIns` is omitted for runtime-facade completion, the runtime defaults to the package-owned completion baseline from `src/complete-defaults.ts`: read-only workspace built-ins plus `ask_user_input`.
- If default-visible `ask_user_input` appears in a runtime completion response and the host did not supply an executable tool for it, the facade returns `status: "tool_calls"` with the assistant message and tool calls. It does not wait for a human, enforce a timeout, or translate the branch into a special human-wait state.
- If the host supplies executable `ask_user_input`, runtime completion executes it like any other host tool and continues with the returned tool message.
- Per-call `skillRoots` are honored even through a bound runtime environment, so a request can narrow or extend skill discovery without rebuilding the whole runtime.
- Before dispatch, the runtime can inject package-owned tool guidance into the first system message. Caller-owned system content, including any embedded AGENTS.md instructions or caller-defined tool policy, should therefore be assembled into one leading system block before the runtime appends its own guidance.
- Managed prompt sections are inserted through `src/prompt-contracts.ts`, which strips and replaces the runtime-owned tagged block rather than stacking duplicates across retries or repeated runtime calls.
- `webSearch` is an explicit per-call option on `generate(...)` and `stream(...)`. `true` normalizes to an empty provider-default config, `false` disables it, and the runtime forwards it only when requested rather than enabling it implicitly for generic OpenAI-compatible backends.
- Cleanup for consumers should usually be `runtime.dispose()` on explicit runtimes. Internal convenience-path cache cleanup still exists in `src/runtime.ts`, but it is not exported from the root entrypoint.
- Explicit-environment cleanup is ownership-aware: only MCP registries created by the runtime are shut down, while caller-injected registries remain caller-owned.
- The legacy test reset helper delegates to the same internal cache-disposal path instead of owning separate shutdown logic.

Design boundary:
- This module owns runtime assembly and provider dispatch.
- It owns lifecycle cleanup only for runtime-created registries and caches.
- It does not own message persistence, queueing, transcript policy, human-input UI, or completion-loop state transitions; those remain in callers or in [[src-completion-loop]].

Read this after [[environment-vs-per-call]] when you need to understand how a single API call becomes a fully resolved runtime surface. For the preferred iterative API built on top of the runtime facade, see [[src-completion-loop]]. For runtime-facade result and stream event shapes, see [[src-runtime-complete-contract]]. For human-input ownership, see [[host-owned-ask-user-input]]. For provider-specific search behavior, see [[web-search-across-providers]]. For system prompt layout, see [[system-prompt-schema]]. For cleanup boundaries, see [[turn-loop-safety-and-lifecycle]].
