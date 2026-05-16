---
title: "Provider Tool-Name Translation"
type: "feature"
status: "active"
language: "default"
source_paths:
  - "src/provider-tool-names.ts"
  - "src/openai-direct.ts"
  - "src/anthropic-direct.ts"
  - "src/google-direct.ts"
  - "tests/llm/provider-tool-names.test.ts"
updated_at: "2026-05-15"
---

`src/provider-tool-names.ts` is the shared adapter helper that keeps runtime tool names portable across provider-specific function-calling limits.

Facts from source:
- `createProviderToolNameTranslator(...)` builds a reversible mapping between runtime tool names and provider-facing tool names.
- Invalid provider characters are normalized to underscores, empty names fall back to `tool`, and overly long names are shortened with a deterministic hash suffix.
- Reserved provider names can be pre-claimed so runtime tools do not collide with provider-owned server tools such as Anthropic web search.
- The translator keeps both directions: adapters send sanitized names to the provider, then map the provider callback back to the original runtime tool name before execution.
- Collision handling is deterministic. When two runtime names normalize to the same provider-safe base, the helper adds hashed suffixes instead of depending on adapter-local counters alone.

Why this matters:
- The runtime tool registry can keep natural names such as dotted or namespaced identifiers.
- Adapters stay aligned on one translation policy instead of each provider inventing slightly different name-fixing rules.
- Tests now lock down long-name shortening, reserved-name avoidance, and reverse lookup so provider integrations do not silently drift.

Read this with [[provider-adapters]] when a provider reports an unexpected tool name or when a tool call reaches the runtime under a different name than the one the host registered.