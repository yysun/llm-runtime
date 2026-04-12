---
title: "MCP Registry"
type: "feature"
status: "active"
source_paths:
  - "src/mcp.ts"
  - "tests/llm/mcp-runtime.test.ts"
  - "src/types.ts"
updated_at: "2026-04-12"
---

`src/mcp.ts` converts MCP server config into executable package-native tools.

Facts from source:
- The registry accepts both `servers` and legacy `mcpServers`, then normalizes them into one config shape.
- Supported transports are `stdio`, `sse`, and `streamable-http`.
- Resolved tools are namespaced as `${serverName}_${toolName}` to avoid collisions across servers.
- Client connections and discovered tool lists are cached per server name plus config hash, so equivalent calls reuse the same MCP discovery work.
- Tool input schemas are reduced to the package's simple JSON-schema subset before exposure and each tool is wrapped with [[src-tool-validation]].

Execution behavior:
- MCP tool results are normalized into deterministic strings for downstream compatibility.
- `shutdown()` closes cached clients and clears tool caches.

The tests in `tests/llm/mcp-runtime.test.ts` verify namespaced tool exposure, actual SDK call routing, cache reuse, and cleanup. Read this with [[src-runtime]] when debugging why an MCP tool is or is not visible in a resolved tool set.