/**
 * LLM Package Runtime Tests
 *
 * Purpose:
 * - Validate the first public runtime slice in `packages/llm`.
 *
 * Key features:
 * - MCP config parsing and normalization.
 * - Ordered skill-root precedence with a mocked filesystem adapter.
 * - Tool resolution and environment behavior through the public per-call API.
 *
 * Implementation notes:
 * - Uses a mocked in-memory filesystem adapter for skill-registry coverage.
 * - Exercises the package through its public entrypoint.
 * - Uses temporary directories for built-in filesystem executor coverage while avoiding network or provider calls.
 *
 * Recent changes:
 * - 2026-05-15: Added coverage for read-only built-in defaults, public tool execution helpers, clean HITL exposure, and abort-aware built-ins.
 * - 2026-05-15: Added `createRuntime(...)` facade coverage.
 * - 2026-03-27: Initial targeted coverage for the new `llm-runtime` package.
 * - 2026-03-27: Added runtime-scoped provider configuration regression coverage.
 * - 2026-03-27: Added built-in tool enablement, narrowing, and host-adapter coverage.
 * - 2026-05-14: Replaced `grep` coverage with filesystem built-in coverage for `search_files`, `create_directory`, and `path_exists`.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

const {
  mockCreateClientForProvider,
  mockGenerateOpenAIResponse,
} = vi.hoisted(() => ({
  mockCreateClientForProvider: vi.fn(() => ({ client: 'openai' })),
  mockGenerateOpenAIResponse: vi.fn(),
}));

vi.mock('../../src/openai-direct.js', async () => {
  const actual = await vi.importActual('../../src/openai-direct.js');
  return {
    ...(actual as object),
    createClientForProvider: mockCreateClientForProvider,
    generateOpenAIResponse: mockGenerateOpenAIResponse,
  };
});

import {
  type PendingHumanInput,
  type RuntimeCompleteResult,
  type RuntimeCompleteStatus,
  type RuntimeStreamCompleteEvent,
  createAskUserInputResult,
  createHumanInputToolResult,
  createRuntime,
  executeToolCall,
  executeToolCalls,
  intersectBuiltInToolSelections,
  parseMCPConfigJson,
  resolveTools,
  type LLMEnvironmentOptions,
  type SkillFileSystemAdapter,
} from '../../src/index.js';
import {
  ASK_USER_INPUT_TOOL_DESCRIPTION,
  ASK_USER_INPUT_TOOL_PARAMETERS,
} from '../../src/human-input-contract.js';

function createMockSkillFileSystem(files: Record<string, string>): SkillFileSystemAdapter {
  const normalizedFiles = new Map(
    Object.entries(files).map(([filePath, content]) => [filePath, content]),
  );

  const directories = new Set<string>();
  for (const filePath of normalizedFiles.keys()) {
    const segments = filePath.split('/').filter(Boolean);
    let current = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      current += `/${segments[index]}`;
      directories.add(current);
    }
  }

  const makeDirent = (name: string, type: 'file' | 'dir') => ({
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file',
    isSymbolicLink: () => false,
  });

  return {
    access: async (targetPath) => {
      if (!directories.has(targetPath) && !normalizedFiles.has(targetPath)) {
        throw new Error(`ENOENT: ${targetPath}`);
      }
    },
    readFile: async (targetPath) => {
      const content = normalizedFiles.get(targetPath);
      if (content === undefined) {
        throw new Error(`ENOENT: ${targetPath}`);
      }
      return content;
    },
    readdir: async (targetPath) => {
      const children = new Map<string, 'file' | 'dir'>();
      const prefix = `${targetPath === '/' ? '' : targetPath}/`;

      for (const directory of directories) {
        if (!directory.startsWith(prefix) || directory === targetPath) continue;
        const remainder = directory.slice(prefix.length);
        if (!remainder || remainder.includes('/')) continue;
        children.set(remainder, 'dir');
      }

      for (const filePath of normalizedFiles.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        if (!remainder || remainder.includes('/')) continue;
        children.set(remainder, 'file');
      }

      return [...children.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, type]) => makeDirent(name, type));
    },
    realpath: async (targetPath) => targetPath,
    stat: async (targetPath) => ({
      isDirectory: () => directories.has(targetPath),
      isFile: () => normalizedFiles.has(targetPath),
    }),
  };
}

async function withTempWorkspace<T>(callback: (workspacePath: string) => Promise<T>): Promise<T> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-runtime-'));

  try {
    return await callback(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

describe('llm-runtime runtime', () => {
  it('parses legacy MCP JSON and normalizes mcpServers into servers', () => {
    const config = parseMCPConfigJson(JSON.stringify({
      mcpServers: {
        fetcher: {
          url: 'https://example.com/mcp',
          transport: 'streamable-http',
          headers: {
            Authorization: 'Bearer test',
          },
        },
      },
    }));

    expect(config).toEqual({
      servers: {
        fetcher: {
          url: 'https://example.com/mcp',
          transport: 'streamable-http',
          headers: {
            Authorization: 'Bearer test',
          },
        },
      },
    });
  });

  it('rejects stdio MCP servers without a command during config parsing', () => {
    expect(() => parseMCPConfigJson(JSON.stringify({
      servers: {
        gemini: {
          command: '   ',
        },
      },
    }))).toThrow('MCP server "gemini" with stdio transport requires a non-empty command');
  });

  it('rejects remote MCP transports without a url during config parsing', () => {
    expect(() => parseMCPConfigJson(JSON.stringify({
      servers: {
        remote: {
          transport: 'streamable-http',
          url: '   ',
        },
      },
    }))).toThrow('MCP server "remote" with streamable-http transport requires a non-empty url');
  });

  it('infers streamable-http transport for url-based MCP servers', () => {
    const config = parseMCPConfigJson(JSON.stringify({
      servers: {
        stitch: {
          url: 'https://stitch.googleapis.com/mcp',
          headers: {
            'X-Goog-Api-Key': 'test-key',
          },
        },
      },
    }));

    expect(config).toEqual({
      servers: {
        stitch: {
          transport: 'streamable-http',
          url: 'https://stitch.googleapis.com/mcp',
          headers: {
            'X-Goog-Api-Key': 'test-key',
          },
        },
      },
    });
  });

  it('applies later skill roots as higher precedence for duplicate skill ids', async () => {
    const fileSystem = createMockSkillFileSystem({
      '/global/find/SKILL.md': '---\nname: find-skills\ndescription: global description\n---\n# Global',
      '/project/find/SKILL.md': '---\nname: find-skills\ndescription: project description\n---\n# Project',
    });

    const environment = createRuntime({
      skillRoots: ['/global', '/project'],
      skillFileSystem: fileSystem,
    });

    const skills = await environment.skillRegistry.listSkills();
    expect(skills).toEqual([
      expect.objectContaining({
        skillId: 'find-skills',
        description: 'project description',
        rootPath: '/project',
      }),
    ]);

    const loadedSkill = await environment.skillRegistry.loadSkill('find-skills');
    expect(loadedSkill?.content).toContain('# Project');
  });

  it('merges extra tools and direct tool overrides deterministically', () => {
    const resolved = resolveTools({
      builtIns: false,
      extraTools: [
        {
          name: 'project_lookup',
          description: 'Project lookup',
          parameters: { type: 'object' },
        },
      ],
      tools: {
        project_write: {
          name: 'project_write',
          description: 'Project write',
          parameters: { type: 'object' },
        },
        project_lookup: {
          name: 'project_lookup',
          description: 'Override lookup',
          parameters: { type: 'object', override: true },
        },
      },
    });

    expect(Object.keys(resolved)).toEqual(['project_lookup', 'project_write']);
    expect(resolved.project_lookup?.description).toBe('Override lookup');
    expect(resolved.project_write?.description).toBe('Project write');
  });

  it('keeps provider configuration isolated per explicit environments', async () => {
    const firstEnvironment = createRuntime({
      providers: {
        openai: {
          apiKey: 'first-openai-key',
        },
      },
    } satisfies LLMEnvironmentOptions);

    const secondEnvironment = createRuntime({
      providers: {
        anthropic: {
          apiKey: 'second-anthropic-key',
        },
      },
    } satisfies LLMEnvironmentOptions);

    expect(firstEnvironment.providerConfigStore.getProviderConfig('openai')).toEqual({
      apiKey: 'first-openai-key',
    });
    expect(firstEnvironment.providerConfigStore.isProviderConfigured('anthropic')).toBe(false);
    expect(() => secondEnvironment.providerConfigStore.getProviderConfig('openai')).toThrow(
      /No configuration found for openai provider/,
    );

    secondEnvironment.providerConfigStore.configureProvider('openai', {
      apiKey: 'second-openai-key',
    });

    expect(firstEnvironment.providerConfigStore.getProviderConfig('openai')).toEqual({
      apiKey: 'first-openai-key',
    });
    expect(secondEnvironment.providerConfigStore.getProviderConfig('openai')).toEqual({
      apiKey: 'second-openai-key',
    });
  });

  it('accepts provider config through the explicit environment options', () => {
    const environment = createRuntime({
      providers: {
        azure: {
          apiKey: 'azure-key',
          resourceName: 'azure-resource',
          deployment: 'gpt-5',
        },
      },
    } satisfies LLMEnvironmentOptions);

    expect(environment.providerConfigStore.getConfigurationStatus()).toMatchObject({
      azure: true,
    });
    expect(environment.providerConfigStore.getProviderConfig('azure')).toEqual({
      apiKey: 'azure-key',
      resourceName: 'azure-resource',
      deployment: 'gpt-5',
    });
  });

  it('creates a runtime facade with bound agentic helpers while preserving the environment surface', async () => {
    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    expect(runtime.providerConfigStore.getProviderConfig('openai')).toEqual({
      apiKey: 'runtime-openai-key',
    });
    expect(typeof runtime.generate).toBe('function');
    expect(typeof runtime.complete).toBe('function');
    expect(typeof runtime.streamComplete).toBe('function');
    expect(typeof runtime.resolveTools).toBe('function');
    expect(typeof runtime.executeToolCall).toBe('function');
    expect(typeof runtime.executeToolCalls).toBe('function');
    expect(typeof runtime.dispose).toBe('function');
    expect('stream' in runtime).toBe(false);
    expect(Object.keys(runtime.resolveTools({ builtIns: { ask_user_input: true } }))).toEqual([
      'ask_user_input',
    ]);

    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it('runs runtime.complete through the hardened completion loop with the existing tool system', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const lookupToolCall = {
      id: 'lookup-1',
      type: 'function' as const,
      function: {
        name: 'project_lookup',
        arguments: '{"query":"token"}',
      },
    };
    const seenSystemPrompts: string[] = [];

    mockGenerateOpenAIResponse.mockImplementation(async (request: any) => {
      const systemPrompt = String(
        request.messages.find((message: any) => message.role === 'system')?.content ?? '',
      );
      seenSystemPrompts.push(systemPrompt);

      const hasLookupResult = request.messages.some((message: any) => (
        message.role === 'tool' && message.tool_call_id === 'lookup-1'
      ));

      if (!hasLookupResult) {
        return {
          type: 'tool_calls',
          content: '',
          tool_calls: [lookupToolCall],
          assistantMessage: {
            role: 'assistant',
            content: '',
            tool_calls: [lookupToolCall],
          },
        };
      }

      return {
        type: 'text',
        content: 'TOKEN=project-token',
        assistantMessage: {
          role: 'assistant',
          content: 'TOKEN=project-token',
        },
      };
    });

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const result = await runtime.complete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Find the token.' }],
      extraTools: [{
        name: 'project_lookup',
        description: 'Lookup the project token.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async () => ({ token: 'project-token' }),
      }],
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: 'TOKEN=project-token',
    });
    expect(result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'lookup-1',
      }),
    ]));
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(2);
    expect(seenSystemPrompts[0]).toContain('Your job is to continue until the user\'s task is complete, blocked, or requires user input.');
    expect(seenSystemPrompts[0]).toContain('Prefer action over explanation.');

    await runtime.dispose();
  });

  it('forwards maxConsecutiveToolTurns through runtime.complete', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const lookupToolCall = {
      id: 'lookup-loop-1',
      type: 'function' as const,
      function: {
        name: 'project_lookup',
        arguments: '{"query":"token"}',
      },
    };

    mockGenerateOpenAIResponse.mockImplementation(async () => ({
      type: 'tool_calls',
      content: '',
      tool_calls: [lookupToolCall],
      assistantMessage: {
        role: 'assistant',
        content: '',
        tool_calls: [lookupToolCall],
      },
    }));

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const result = await runtime.complete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Keep looking until done.' }],
      maxConsecutiveToolTurns: 1,
      extraTools: [{
        name: 'project_lookup',
        description: 'Lookup the project token.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async () => ({ token: 'project-token' }),
      }],
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Completion loop exceeded the maximum number of consecutive tool turns.');
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });

  it('forwards maxWallTimeMs through runtime.complete', async () => {
    mockGenerateOpenAIResponse.mockReset();

    mockGenerateOpenAIResponse.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        type: 'text',
        content: 'done',
        assistantMessage: {
          role: 'assistant',
          content: 'done',
        },
      };
    });

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const result = await runtime.complete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Finish quickly.' }],
      maxWallTimeMs: 10,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Completion loop timed out before producing a final answer.');
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  it('rejects plain assistant narration that only announces future work', async () => {
    mockGenerateOpenAIResponse.mockReset();

    mockGenerateOpenAIResponse.mockResolvedValue({
      type: 'text',
      content: 'I will inspect the project files next.',
      assistantMessage: {
        role: 'assistant',
        content: 'I will inspect the project files next.',
      },
    });

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const result = await runtime.complete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Inspect the project files.' }],
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('required evidence');
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(3);

    await runtime.dispose();
  });

  it('fails runtime.complete when ask_user_input is mixed with other tool calls', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const executeLookup = vi.fn(async () => ({ token: 'project-token' }));

    mockGenerateOpenAIResponse.mockResolvedValue({
      type: 'tool_calls',
      content: '',
      tool_calls: [
        {
          id: 'lookup-mixed-1',
          type: 'function' as const,
          function: {
            name: 'project_lookup',
            arguments: '{"query":"token"}',
          },
        },
        {
          id: 'hitl-mixed-1',
          type: 'function' as const,
          function: {
            name: 'ask_user_input',
            arguments: '{"questions":[{"header":"Scope","id":"scope","question":"Which scope?","options":[{"id":"all","label":"All"},{"id":"one","label":"One"}]}]}',
          },
        },
      ],
      assistantMessage: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'lookup-mixed-1',
            type: 'function' as const,
            function: {
              name: 'project_lookup',
              arguments: '{"query":"token"}',
            },
          },
          {
            id: 'hitl-mixed-1',
            type: 'function' as const,
            function: {
              name: 'ask_user_input',
              arguments: '{"questions":[{"header":"Scope","id":"scope","question":"Which scope?","options":[{"id":"all","label":"All"},{"id":"one","label":"One"}]}]}',
            },
          },
        ],
      },
    });

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const result = await runtime.complete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Find the token and ask me about scope.' }],
      builtIns: {
        ask_user_input: true,
      },
      extraTools: [{
        name: 'project_lookup',
        description: 'Lookup the project token.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: executeLookup,
      }],
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('ask_user_input must be the only tool call');
    expect(executeLookup).not.toHaveBeenCalled();
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  it('fails runtime.complete on empty assistant text without tool calls', async () => {
    mockGenerateOpenAIResponse.mockReset();

    mockGenerateOpenAIResponse.mockResolvedValue({
      type: 'text',
      content: '',
      assistantMessage: {
        role: 'assistant',
        content: '',
      },
    });

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const result = await runtime.complete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Do the task.' }],
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Assistant returned neither tool calls nor non-empty text.');
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  it('defaults runtime.complete to ask_user_input and passes request context into completion-loop tools', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const abortController = new AbortController();
    const lookupToolCall = {
      id: 'lookup-context-1',
      type: 'function' as const,
      function: {
        name: 'project_lookup',
        arguments: '{"query":"token"}',
      },
    };
    let seenContext: any;

    mockGenerateOpenAIResponse.mockImplementation(async (request: any) => {
      expect(request.tools).toEqual(expect.objectContaining({
        ask_user_input: expect.objectContaining({ name: 'ask_user_input' }),
      }));

      const hasLookupResult = request.messages.some((message: any) => (
        message.role === 'tool' && message.tool_call_id === 'lookup-context-1'
      ));

      if (!hasLookupResult) {
        return {
          type: 'tool_calls',
          content: '',
          tool_calls: [lookupToolCall],
          assistantMessage: {
            role: 'assistant',
            content: '',
            tool_calls: [lookupToolCall],
          },
        };
      }

      return {
        type: 'text',
        content: 'done',
        assistantMessage: {
          role: 'assistant',
          content: 'done',
        },
      };
    });

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const result = await runtime.complete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Find the token.' }],
      context: {
        workingDirectory: '/tmp/project',
        abortSignal: abortController.signal,
        metadata: { requestId: 'request-1' },
      },
      extraTools: [{
        name: 'project_lookup',
        description: 'Lookup the project token.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async (_args, context) => {
          seenContext = context;
          return { token: 'project-token' };
        },
      }],
    });

    expect(result.status).toBe('completed');
    expect(seenContext).toEqual(expect.objectContaining({
      workingDirectory: '/tmp/project',
      abortSignal: abortController.signal,
      metadata: { requestId: 'request-1' },
      toolCallId: 'lookup-context-1',
    }));
    expect(seenContext.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [lookupToolCall] }),
    ]));

    await runtime.dispose();
  });

  it('exports human-input result helpers for resuming ask_user_input runs', () => {
    const pending = {
      toolCallId: 'hitl-1',
      toolName: 'ask_user_input',
      request: { questions: [] },
    };
    const answer = { answers: { scope: 'all' } };

    expect(createHumanInputToolResult(pending, answer)).toEqual({
      role: 'tool',
      tool_call_id: 'hitl-1',
      name: 'ask_user_input',
      content: JSON.stringify(answer),
    });
    expect(createAskUserInputResult(pending, answer)).toEqual(createHumanInputToolResult(pending, answer));
  });

  it('exports the runtime completion contract types from the package root', () => {
    const pending: PendingHumanInput = {
      toolCallId: 'hitl-1',
      toolName: 'ask_user_input',
      request: { questions: [] },
    };
    const status: RuntimeCompleteStatus = 'waiting_for_human';
    const result: RuntimeCompleteResult = {
      status,
      messages: [],
      pendingHumanInput: pending,
    };
    const event: RuntimeStreamCompleteEvent = {
      type: 'waiting_for_human',
      pendingHumanInput: pending,
      messages: [],
      iteration: 1,
    };

    expect(result.pendingHumanInput).toEqual(pending);
    expect(event.type).toBe('waiting_for_human');
  });

  it('reuses the canonical ask_user_input contract in the built-in tool catalog', () => {
    const tool = resolveTools({
      builtIns: {
        ask_user_input: true,
      },
    }).ask_user_input;

    expect(tool).toBeDefined();
    expect(ASK_USER_INPUT_TOOL_DESCRIPTION).toBe(tool?.description);
    expect(ASK_USER_INPUT_TOOL_PARAMETERS).toEqual(tool?.parameters);
  });

  it('streams agentic lifecycle events through runtime.streamComplete', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const lookupToolCall = {
      id: 'lookup-2',
      type: 'function' as const,
      function: {
        name: 'project_lookup',
        arguments: '{"query":"token"}',
      },
    };

    mockGenerateOpenAIResponse.mockImplementation(async (request: any) => {
      const hasLookupResult = request.messages.some((message: any) => (
        message.role === 'tool' && message.tool_call_id === 'lookup-2'
      ));

      if (!hasLookupResult) {
        return {
          type: 'tool_calls',
          content: '',
          tool_calls: [lookupToolCall],
          assistantMessage: {
            role: 'assistant',
            content: '',
            tool_calls: [lookupToolCall],
          },
        };
      }

      return {
        type: 'text',
        content: 'TOKEN=project-token',
        assistantMessage: {
          role: 'assistant',
          content: 'TOKEN=project-token',
        },
      };
    });

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const eventTypes: string[] = [];

    for await (const event of runtime.streamComplete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Find the token.' }],
      extraTools: [{
        name: 'project_lookup',
        description: 'Lookup the project token.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async () => ({ token: 'project-token' }),
      }],
    })) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toEqual([
      'model_start',
      'assistant_message',
      'tool_start',
      'tool_result',
      'model_start',
      'assistant_message',
      'completed',
    ]);

    await runtime.dispose();
  });

  it('fails runtime.streamComplete on plain assistant narration that only announces future work', async () => {
    mockGenerateOpenAIResponse.mockReset();

    mockGenerateOpenAIResponse.mockResolvedValue({
      type: 'text',
      content: 'I will inspect the project files next.',
      assistantMessage: {
        role: 'assistant',
        content: 'I will inspect the project files next.',
      },
    });

    const runtime = createRuntime({
      providers: {
        openai: {
          apiKey: 'runtime-openai-key',
        },
      },
    });

    const eventTypes: string[] = [];
    let finalEvent: RuntimeStreamCompleteEvent | undefined;

    for await (const event of runtime.streamComplete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Inspect the project files.' }],
    })) {
      eventTypes.push(event.type);
      finalEvent = event;
    }

    expect(eventTypes).toEqual([
      'model_start',
      'assistant_message',
      'model_start',
      'assistant_message',
      'model_start',
      'assistant_message',
      'failed',
    ]);
    expect(finalEvent).toEqual(expect.objectContaining({
      type: 'failed',
      result: expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('required evidence'),
      }),
    }));
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(3);

    await runtime.dispose();
  });

  it('includes only the read-only built-ins by default', () => {
    expect(Object.keys(resolveTools()).sort()).toEqual([
      'list_files',
      'load_skill',
      'path_exists',
      'read_file',
      'search_files',
    ]);
  });

  it('exposes only ask_user_input for human input', () => {
    expect(Object.keys(resolveTools({ builtIns: { ask_user_input: true } }))).toEqual([
      'ask_user_input',
    ]);

    expect(() => resolveTools({
      builtIns: { human_intervention_request: true } as any,
    })).toThrow('Unknown built-in tool name "human_intervention_request".');
    expect(() => resolveTools({
      builtIns: { ask_user_question: true } as any,
    })).toThrow('Unknown built-in tool name "ask_user_question".');
  });

  it('supports per-call built-in selection', () => {
    const resolved = resolveTools({
      builtIns: {
        create_directory: true,
        path_exists: true,
        shell_cmd: true,
        read_file: true,
        search_files: true,
      },
    });

    expect(Object.keys(resolved).sort()).toEqual([
      'create_directory',
      'path_exists',
      'read_file',
      'search_files',
      'shell_cmd',
    ].sort());
  });

  it('rejects unknown built-in selection keys such as removed grep', () => {
    expect(() => resolveTools({
      builtIns: {
        grep: true,
      } as any,
    })).toThrow('Unknown built-in tool name "grep".');
  });

  it('searches files by glob pattern with deterministic results', async () => {
    await withTempWorkspace(async (workspacePath) => {
      await fs.writeFile(path.join(workspacePath, 'alpha.ts'), 'export const alpha = 1;');
      await fs.mkdir(path.join(workspacePath, 'nested'), { recursive: true });
      await fs.writeFile(path.join(workspacePath, 'nested', 'beta.ts'), 'export const beta = 2;');
      await fs.writeFile(path.join(workspacePath, 'nested', 'notes.md'), '# Notes');

      const tools = resolveTools({
        builtIns: {
          search_files: true,
        },
      });

      const result = await tools.search_files?.execute?.({
        pattern: '**/*.ts',
      }, {
        workingDirectory: workspacePath,
      });

      expect(JSON.parse(String(result))).toEqual(expect.objectContaining({
        found: true,
        pattern: '**/*.ts',
        total: 2,
        returned: 2,
        truncated: false,
        entries: ['alpha.ts', 'nested/beta.ts'],
      }));
    });
  });

  it('creates directories idempotently and reports path existence', async () => {
    await withTempWorkspace(async (workspacePath) => {
      const tools = resolveTools({
        builtIns: {
          create_directory: true,
          path_exists: true,
        },
      });

      const createResult = await tools.create_directory?.execute?.({
        path: 'reports/daily',
      }, {
        workingDirectory: workspacePath,
      });
      const createdDirectory = JSON.parse(String(createResult));

      expect(createdDirectory).toMatchObject({
        ok: true,
        status: 'success',
        created: true,
        existed: false,
      });

      const secondCreateResult = await tools.create_directory?.execute?.({
        path: 'reports/daily',
      }, {
        workingDirectory: workspacePath,
      });

      expect(JSON.parse(String(secondCreateResult))).toMatchObject({
        ok: true,
        created: false,
        existed: true,
      });

      await fs.writeFile(path.join(workspacePath, 'reports', 'daily', 'summary.txt'), 'ready');

      const directoryExistsResult = await tools.path_exists?.execute?.({
        path: 'reports/daily',
      }, {
        workingDirectory: workspacePath,
      });
      const fileExistsResult = await tools.path_exists?.execute?.({
        path: 'reports/daily/summary.txt',
      }, {
        workingDirectory: workspacePath,
      });
      const missingExistsResult = await tools.path_exists?.execute?.({
        path: 'reports/missing.txt',
      }, {
        workingDirectory: workspacePath,
      });

      expect(JSON.parse(String(directoryExistsResult))).toMatchObject({
        exists: true,
        type: 'directory',
        isDirectory: true,
        isFile: false,
      });
      expect(JSON.parse(String(fileExistsResult))).toMatchObject({
        exists: true,
        type: 'file',
        isDirectory: false,
        isFile: true,
      });
      expect(JSON.parse(String(missingExistsResult))).toMatchObject({
        exists: false,
        type: null,
        isDirectory: false,
        isFile: false,
      });
    });
  });

  it('keeps ask_user_input selection explicit', () => {
    const resolved = resolveTools({
      builtIns: {
        ask_user_input: true,
      },
    });

    expect(Object.keys(resolved).sort()).toEqual(['ask_user_input']);
  });

  it('keeps ask_user_input selection in built-in intersection helpers', () => {
    expect(intersectBuiltInToolSelections(true, {
      ask_user_input: true,
    })).toMatchObject({
      ask_user_input: true,
    });

    expect(() => intersectBuiltInToolSelections(true, {
      human_intervention_request: true,
    } as any)).toThrow('Unknown built-in tool name "human_intervention_request".');
  });

  it('executes built-in tools through the public helper', async () => {
    await withTempWorkspace(async (workspacePath) => {
      await fs.writeFile(path.join(workspacePath, 'note.txt'), 'hello from helper');

      const result = await executeToolCall({
        toolCall: {
          id: 'tool-read-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ filePath: 'note.txt' }),
          },
        },
        builtIns: {
          read_file: true,
        },
        context: {
          workingDirectory: workspacePath,
        },
      });

      expect(JSON.parse(String(result))).toEqual(expect.objectContaining({
        content: 'hello from helper',
      }));
    });
  });

  it('keeps public tool execution throwing by default for setup errors', async () => {
    await expect(executeToolCall({
      builtIns: false,
      toolCall: {
        id: 'missing-tool-1',
        type: 'function',
        function: { name: 'missing_tool', arguments: '{}' },
      },
    })).rejects.toThrow('Tool "missing_tool" is not available in the current runtime.');

    await expect(executeToolCall({
      builtIns: false,
      tools: {
        lookup: {
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object' },
          execute: async () => 'unused',
        },
      },
      toolCall: {
        id: 'bad-json-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{bad-json' },
      },
    })).rejects.toThrow('Tool "lookup" arguments are not valid JSON');

    await expect(executeToolCall({
      builtIns: false,
      tools: {
        lookup: {
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object' },
        },
      },
      toolCall: {
        id: 'non-executable-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      },
    })).rejects.toThrow('Tool "lookup" is not executable.');
  });

  it('can return durable tool-execution artifacts instead of throwing', async () => {
    const invalidJsonResult = await executeToolCall({
      builtIns: false,
      errorMode: 'return-artifact',
      tools: {
        lookup: {
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object' },
          execute: async () => 'unused',
        },
      },
      toolCall: {
        id: 'bad-json-2',
        type: 'function',
        function: { name: 'lookup', arguments: '{bad-json' },
      },
    });

    expect(invalidJsonResult).toEqual(expect.objectContaining({
      ok: false,
      status: 'error',
      errorType: 'tool_execution_failed',
      toolCallId: 'bad-json-2',
      toolName: 'lookup',
      code: 'invalid_arguments_json',
    }));

    const batchResult = await executeToolCalls({
      builtIns: false,
      errorMode: 'return-artifact',
      tools: {
        lookup: {
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object' },
          execute: async (args) => `lookup:${args.id}`,
        },
      },
      toolCalls: [
        {
          id: 'missing-tool-2',
          type: 'function',
          function: { name: 'missing_tool', arguments: '{}' },
        },
        {
          id: 'lookup-1',
          type: 'function',
          function: { name: 'lookup', arguments: JSON.stringify({ id: '42' }) },
        },
      ],
    });

    expect(batchResult).toEqual([
      expect.objectContaining({
        errorType: 'tool_execution_failed',
        toolCallId: 'missing-tool-2',
        toolName: 'missing_tool',
        code: 'unknown_tool',
      }),
      'lookup:42',
    ]);
  });

  it('rejects removed HITL aliases during public tool execution', async () => {
    await expect(executeToolCall({
      toolCall: {
        id: 'tool-hitl-1',
        type: 'function',
        function: {
          name: 'human_intervention_request',
          arguments: JSON.stringify({
            questions: [{
              header: 'Approval',
              id: 'approval',
              question: 'Proceed?',
              options: [
                { id: 'yes', label: 'Yes' },
                { id: 'no', label: 'No' },
              ],
            }],
          }),
        },
      },
      builtIns: {
        ask_user_input: true,
      },
    })).rejects.toThrow('Tool "human_intervention_request" is not available in the current runtime.');
  });

  it('honors abort signals in package-owned shell, search, and fetch executors', async () => {
    await withTempWorkspace(async (workspacePath) => {
      const tools = resolveTools({
        builtIns: {
          shell_cmd: true,
          search_files: true,
          web_fetch: true,
        },
      });

      const shellAbortController = new AbortController();
      const shellPromise = tools.shell_cmd?.execute?.({
        command: process.execPath,
        parameters: ['-e', 'setTimeout(() => process.exit(0), 10000)'],
        output_format: 'json',
      }, {
        workingDirectory: workspacePath,
        abortSignal: shellAbortController.signal,
      });
      shellAbortController.abort(new Error('stop shell execution'));
      const shellResult = JSON.parse(String(await shellPromise));

      const searchResult = await tools.search_files?.execute?.({
        pattern: '**/*.ts',
      }, {
        workingDirectory: workspacePath,
        abortSignal: AbortSignal.abort(new Error('stop search execution')),
      });

      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn(async () => {
        throw new Error('fetch should not run when already aborted');
      });
      globalThis.fetch = fetchSpy as typeof fetch;
      try {
        const fetchResult = await tools.web_fetch?.execute?.({
          url: 'https://example.com',
        }, {
          abortSignal: AbortSignal.abort(new Error('stop fetch execution')),
        });

        expect(shellResult).toEqual(expect.objectContaining({ aborted: true }));
        expect(String(searchResult)).toContain('aborted');
        expect(String(fetchResult)).toContain('aborted');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('returns a pending HITL request artifact without requiring an adapter', async () => {
    const tools = resolveTools({
      builtIns: { ask_user_input: true },
    });
    const result = await tools.ask_user_input?.execute?.({
      questions: [{
        header: 'Approval',
        id: 'approval',
        question: 'Approve?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      }],
    }, {
      toolCallId: 'hitl-call-1',
    });

    expect(result).toContain('"status": "pending"');
    expect(result).toContain('"pending": true');
    expect(result).toContain('"requestId": "hitl-call-1"');
    expect(result).toContain('"type": "single-select"');
    expect(result).toContain('"allowSkip": false');
    expect(result).toContain('"questions": [');
  });

  it('lets ask_user_input execute the same HITL pending flow', async () => {
    const tools = resolveTools({ builtIns: { ask_user_input: true } });
    const result = await tools.ask_user_input?.execute?.({
      questions: [{
        header: 'Continue',
        id: 'continue',
        question: 'Continue?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      }],
    }, {
      toolCallId: 'hitl-call-ask-1',
    });

    expect(result).toContain('"status": "pending"');
    expect(result).toContain('"requestId": "hitl-call-ask-1"');
    expect(result).toContain('"question": "Continue?"');
  });

  it('exposes the structured ask_user_input choice schema', () => {
    const tools = resolveTools({
      builtIns: { ask_user_input: true },
    });
    const askSchema = tools.ask_user_input?.parameters as any;

    expect(tools.ask_user_input?.description).toContain('Use questions[]');
    expect(tools.ask_user_input?.description).toContain('do not use allowSkip for approval-gated or otherwise blocking decisions');
    expect(tools.ask_user_input?.description).toContain('Do not add a kind field');
    expect(tools.ask_user_input?.description).toContain('Flat question/options payloads are not supported');
    expect(askSchema.description).toContain('Flat question/options payloads are not supported');
    expect(askSchema.properties.type.enum).toEqual(['single-select', 'multiple-select']);
    expect(askSchema.properties.type.description).toContain('Do not use kind or approval');
    expect(askSchema.properties.allowSkip.type).toBe('boolean');
    expect(askSchema.properties.allowSkip.description).toContain('explicitly dismissible, non-blocking prompts');
    expect(askSchema.properties.allowSkip.description).toContain('Do not use allowSkip for approval-gated or otherwise blocking decisions');
    expect(askSchema.properties.questions.type).toBe('array');
    expect(askSchema.properties.questions.description).toContain('at least two options');
    expect(askSchema.properties.question).toBeUndefined();
    expect(askSchema.properties.options).toBeUndefined();
    expect(askSchema.properties.defaultOption).toBeUndefined();
    expect(askSchema.properties.timeoutMs).toBeUndefined();
    expect(askSchema.properties.metadata).toBeUndefined();
    expect(askSchema.properties.questions.items.properties.options.items.properties).toMatchObject({
      id: { type: 'string', description: expect.any(String) },
      label: { type: 'string', description: expect.any(String) },
      description: { type: 'string', description: expect.any(String) },
    });
    expect(askSchema.required).toEqual(['questions']);
  });

  it('returns structured single-select HITL artifacts by default', async () => {
    const tools = resolveTools({ builtIns: { ask_user_input: true } });
    const result = await tools.ask_user_input?.execute?.({
      questions: [{
        header: 'Mode',
        id: 'mode',
        question: 'Which mode?',
        options: [
          { id: 'fast', label: 'Fast', description: 'Use quicker defaults.' },
          { id: 'careful', label: 'Careful' },
        ],
      }],
    }, {
      toolCallId: 'hitl-structured-1',
    });

    const parsed = JSON.parse(String(result));
    expect(parsed).toMatchObject({
      status: 'pending',
      pending: true,
      requestId: 'hitl-structured-1',
      type: 'single-select',
      allowSkip: false,
    });
    expect(parsed.selectedOption).toBeUndefined();
    expect(parsed.selectedOptions).toBeUndefined();
    expect(parsed.question).toBeUndefined();
    expect(parsed.options).toBeUndefined();
    expect(parsed.questions).toEqual([{
      header: 'Mode',
      id: 'mode',
      question: 'Which mode?',
      options: [
        { id: 'fast', label: 'Fast', description: 'Use quicker defaults.' },
        { id: 'careful', label: 'Careful' },
      ],
    }]);
  });

  it('preserves multiple-select and allowSkip in structured HITL artifacts', async () => {
    const tools = resolveTools({ builtIns: { ask_user_input: true } });
    const result = await tools.ask_user_input?.execute?.({
      type: 'multiple-select',
      allowSkip: true,
      questions: [{
        header: 'Tools',
        id: 'tools',
        question: 'Which tools?',
        options: [
          { id: 'lint', label: 'Lint' },
          { id: 'test', label: 'Test' },
        ],
      }],
    });

    const parsed = JSON.parse(String(result));
    expect(parsed.type).toBe('multiple-select');
    expect(parsed.allowSkip).toBe(true);
    expect(parsed.questions[0].options.map((option: { id: string }) => option.id)).toEqual(['lint', 'test']);
  });

  it('rejects invalid structured HITL questions and option ids', async () => {
    const tools = resolveTools({ builtIns: { ask_user_input: true } });

    const duplicateResult = await tools.ask_user_input?.execute?.({
      questions: [{
        header: 'Mode',
        id: 'mode',
        question: 'Which mode?',
        options: [
          { id: 'same', label: 'One' },
          { id: 'same', label: 'Two' },
        ],
      }],
    });

    expect(duplicateResult).toContain('"errorType": "tool_parameter_validation_failed"');
    expect(duplicateResult).toContain('questions[0].options[1].id must be unique');

    const oneOptionResult = await tools.ask_user_input?.execute?.({
      questions: [{
        header: 'Mode',
        id: 'mode',
        question: 'Which mode?',
        options: [
          { id: 'one', label: 'One' },
        ],
      }],
    });

    expect(oneOptionResult).toContain('questions[0].options must include at least two options');
  });

  it('rejects unsupported HITL selection types', async () => {
    const tools = resolveTools({ builtIns: { ask_user_input: true } });
    const result = await tools.ask_user_input?.execute?.({
      type: 'approval',
      questions: [{
        header: 'Decision',
        id: 'decision',
        question: 'Approve?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      }],
    });

    expect(result).toContain("Parameter 'type' must be one of single-select, multiple-select");
  });

  it('rejects flat HITL payload fields', async () => {
    const tools = resolveTools({ builtIns: { ask_user_input: true } });
    const result = await tools.ask_user_input?.execute?.({
      question: 'Continue?',
      options: ['Yes', 'No'],
    } as any);

    expect(result).toContain('"errorType": "tool_parameter_validation_failed"');
    expect(result).toContain('"path": "question"');
    expect(result).toContain('"code": "unknown_parameter"');
    expect(result).toContain("Unknown parameter 'question' is not allowed");
  });

  it('rejects attempts to override reserved built-in tool names', () => {
    expect(() => resolveTools({
      extraTools: [
        {
          name: 'read_file',
          description: 'override',
          parameters: { type: 'object' },
        },
      ],
    })).toThrow(
      'Tool name "read_file" is reserved by llm-runtime built-ins.',
    );

    expect(() => resolveTools({
      extraTools: [
        {
          name: 'ask_user_input',
          description: 'override',
          parameters: { type: 'object' },
        },
      ],
    })).toThrow(
      'Tool name "ask_user_input" is reserved by llm-runtime built-ins.',
    );
  });

  it('returns a durable validation artifact for missing required parameters', async () => {
    const tools = resolveTools({
      builtIns: { ask_user_input: true },
    });

    const missingQuestionsResult = await tools.ask_user_input?.execute?.({} as any);

    expect(missingQuestionsResult).toContain('"errorType": "tool_parameter_validation_failed"');
    expect(missingQuestionsResult).toContain('"path": "questions"');
    expect(missingQuestionsResult).toContain('"code": "missing_required"');
    expect(missingQuestionsResult).toContain("Required parameter 'questions' is missing or empty");
  });

  it('creates an explicit environment without relying on convenience caches', () => {
    const environment = createRuntime({
      providers: {
        openai: {
          apiKey: 'env-openai-key',
        },
      },
    });

    expect(environment.providerConfigStore.getProviderConfig('openai')).toEqual({
      apiKey: 'env-openai-key',
    });
  });

  it('does not dispose caller-owned registries through the public environment cleanup API', async () => {
    let shutdownCalls = 0;
    const environment = createRuntime({
      mcpRegistry: {
        getConfig: () => null,
        setConfig: () => undefined,
        listServers: () => [],
        resolveTools: async () => ({}),
        shutdown: async () => {
          shutdownCalls += 1;
        },
      },
    });

    await expect(environment.dispose()).resolves.toBeUndefined();
    await expect(environment.dispose()).resolves.toBeUndefined();
    expect(shutdownCalls).toBe(0);
  });
});
