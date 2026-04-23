/**
 * LLM Package MCP Runtime Tests
 *
 * Purpose:
 * - Validate package-owned MCP tool resolution and execution.
 *
 * Key features:
 * - Covers MCP config parsing into executable tools.
 * - Verifies namespaced MCP tool exposure through both runtime and per-call async resolution paths.
 * - Verifies MCP tool execution is routed through the SDK client wrapper.
 *
 * Implementation notes:
 * - Uses mocked MCP SDK clients/transports with no real process or network activity.
 * - Exercises the public runtime and registry surfaces from `packages/llm`.
 *
 * Recent changes:
 * - 2026-03-27: Initial MCP runtime coverage for the publishable `llm-runtime` package.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLLMEnvironment,
  disposeLLMEnvironment,
  disposeLLMRuntimeCaches,
  resolveToolsAsync,
} from '../../src/runtime.js';

const {
  mockClientConnect,
  mockClientClose,
  mockClientListTools,
  mockClientCallTool,
  listToolsPayload,
} = vi.hoisted(() => ({
  mockClientConnect: vi.fn(),
  mockClientClose: vi.fn(),
  mockClientListTools: vi.fn(),
  mockClientCallTool: vi.fn(),
  listToolsPayload: [] as any[],
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    options: any;
    constructor(options: any) {
      this.options = options;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSEClientTransport {
    url: URL;
    options: any;
    constructor(url: URL, options: any) {
      this.url = url;
      this.options = options;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    url: URL;
    options: any;
    constructor(url: URL, options: any) {
      this.url = url;
      this.options = options;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect(transport: any) {
      mockClientConnect(transport);
    }

    async close() {
      mockClientClose();
    }

    async listTools() {
      mockClientListTools();
      return { tools: [...listToolsPayload] };
    }

    async callTool(payload: any) {
      return mockClientCallTool(payload);
    }
  },
}));

describe('llm-runtime MCP runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listToolsPayload.length = 0;
    mockClientCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'mcp-result' }],
    });
  });

  afterEach(async () => {
    await disposeLLMRuntimeCaches();
  });

  it('resolves executable MCP tools through an explicit environment', async () => {
    listToolsPayload.push({
      name: 'lookup',
      description: 'Lookup tool',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    });

    const environment = createLLMEnvironment({
      mcpConfig: {
        servers: {
          demo: {
            command: 'node',
            args: ['demo.js'],
            transport: 'stdio',
          },
        },
      },
    });

    const tools = await resolveToolsAsync({
      environment,
      builtIns: false,
    });
    expect(Object.keys(tools)).toEqual(['demo_lookup']);

    const result = await tools.demo_lookup?.execute?.({
      query: 'hello',
    });

    expect(result).toBe('mcp-result');
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
    expect(mockClientListTools).toHaveBeenCalledTimes(1);
    expect(mockClientCallTool).toHaveBeenCalledWith({
      name: 'lookup',
      arguments: {
        query: 'hello',
      },
    });

    await disposeLLMEnvironment(environment);
    expect(mockClientClose).toHaveBeenCalledTimes(1);
  });

  it('reuses cached MCP tool discovery across equivalent per-call requests', async () => {
    listToolsPayload.push({
      name: 'lookup',
      description: 'Lookup tool',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    });

    const mcpConfig = {
      servers: {
        demo: {
          command: 'node',
          args: ['demo.js'],
          transport: 'stdio' as const,
        },
      },
    };

    const firstTools = await resolveToolsAsync({
      mcpConfig,
      builtIns: false,
    });
    const secondTools = await resolveToolsAsync({
      mcpConfig,
      builtIns: false,
    });

    expect(Object.keys(firstTools)).toEqual(['demo_lookup']);
    expect(Object.keys(secondTools)).toEqual(['demo_lookup']);
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
    expect(mockClientListTools).toHaveBeenCalledTimes(1);
  });

  it('disposes cached MCP resources through the public runtime cleanup API', async () => {
    listToolsPayload.push({
      name: 'lookup',
      description: 'Lookup tool',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    });

    const mcpConfig = {
      servers: {
        demo: {
          command: 'node',
          args: ['demo.js'],
          transport: 'stdio' as const,
        },
      },
    };

    await resolveToolsAsync({
      mcpConfig,
      builtIns: false,
    });
    await disposeLLMRuntimeCaches();
    await resolveToolsAsync({
      mcpConfig,
      builtIns: false,
    });

    expect(mockClientClose).toHaveBeenCalledTimes(1);
    expect(mockClientConnect).toHaveBeenCalledTimes(2);
    expect(mockClientListTools).toHaveBeenCalledTimes(2);
  });

  it('fails fast before spawning when a stdio MCP server command is empty', async () => {
    await expect(resolveToolsAsync({
      mcpConfig: {
        servers: {
          gemini: {
            command: '   ',
            transport: 'stdio',
          },
        },
      },
      builtIns: false,
    })).rejects.toThrow('MCP server "gemini" with stdio transport requires a non-empty command');

    expect(mockClientConnect).not.toHaveBeenCalled();
    expect(mockClientListTools).not.toHaveBeenCalled();
  });

  it('uses streamable-http when a server provides a url without an explicit transport', async () => {
    listToolsPayload.push({
      name: 'lookup',
      description: 'Lookup tool',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    });

    const tools = await resolveToolsAsync({
      mcpConfig: {
        servers: {
          stitch: {
            url: 'https://stitch.googleapis.com/mcp',
            headers: {
              'X-Goog-Api-Key': 'test-key',
            },
          },
        },
      },
      builtIns: false,
    });

    expect(Object.keys(tools)).toEqual(['stitch_lookup']);
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
    expect(mockClientConnect.mock.calls[0]?.[0]).toMatchObject({
      url: new URL('https://stitch.googleapis.com/mcp'),
      options: {
        requestInit: {
          headers: {
            'X-Goog-Api-Key': 'test-key',
          },
        },
      },
    });
    expect(mockClientListTools).toHaveBeenCalledTimes(1);
  });
});
