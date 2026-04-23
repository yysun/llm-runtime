---
title: "MCP Registry"
type: "feature"
status: "active"
source_paths:
  - "src/mcp.ts"
  - "tests/llm/mcp-runtime.test.ts"
  - "src/types.ts"
updated_at: "2026-04-23"
---

`src/mcp.ts` converts MCP server config into executable package-native tools.

Facts from source:
- The registry accepts both `servers` and legacy `mcpServers`, then normalizes them into one config shape.
- Supported transports are `stdio`, `sse`, and `streamable-http`. When a server provides a `url` but no explicit transport, the registry defaults that server to `streamable-http`.
- Resolved tools are namespaced as `${serverName}_${toolName}` to avoid collisions across servers.
- Client connections and discovered tool lists are cached per server name plus config hash, so equivalent calls reuse the same MCP discovery work until public cleanup runs.
- Config validation is intentionally strict: empty stdio commands fail before a client is spawned, and remote transports require a non-empty URL. Headers and env values must be string maps.
- MCP execution results are normalized into deterministic strings. If the SDK result reports `isError` or `type: 'error'`, the runtime returns a stable `Error: MCP tool execution failed - ...` string instead of opaque provider objects.

Execution behavior:
- `shutdown()` closes cached clients and clears tool caches.

The tests in `tests/llm/mcp-runtime.test.ts` verify namespaced tool exposure, actual SDK call routing, cache reuse, cleanup, fail-fast config validation, and URL-plus-header remote transport wiring. Read this with [[src-runtime]] when debugging why an MCP tool is or is not visible in a resolved tool set.
