---
title: "Environment vs Per-Call"
type: "concept"
status: "active"
source_paths:
  - "README.md"
  - "src/runtime.ts"
  - "src/types.ts"
updated_at: "2026-04-12"
---

The package is designed around one rule: stable harness state belongs in `environment`, while request-specific state stays per call.

Facts from source:
- `createLLMEnvironment(...)` builds or accepts an explicit provider config store, MCP registry, skill registry, and default `reasoningEffort` / `toolPermission` values.
- Per-call request data still carries `provider`, `model`, `messages`, `workingDirectory`, `reasoningEffort`, `toolPermission`, and `abortSignal`.
- When no explicit environment is supplied, [[src-runtime]] builds a cached environment from provider configs, MCP config, and skill roots.

Why it matters:
- Explicit environments isolate runtime state cleanly across tests or multiple harnesses.
- The convenience path stays simple for one-off calls, but cache ownership remains package-local.
- Tool execution context is still per call, even when the tool catalog was resolved from environment-level registries.

Use this page together with [[src-runtime]] and [[public-types]] when deciding whether a new input should become a stable harness dependency or remain a request-local option.