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
 * - 2026-05-27: Removed runtime `agentControlMode`/`terminationMode` opt-outs; tests rely on the new control-tool termination default.
 * - 2026-05-27: Added streaming delta and control-tool termination coverage.
 * - 2026-05-27: Added runtime completion coverage for empty-text recovery after loading a skill.
 * - 2026-05-27: Added regression coverage for read-only file tools resolving loaded-skill referenced paths from the skill root.
 * - 2026-05-18: Added focused contract coverage for file-tool validation, uncapped read pagination, hidden entry discovery, and symlink-aware path checks.
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
  mockStreamOpenAIResponse,
} = vi.hoisted(() => ({
  mockCreateClientForProvider: vi.fn(() => ({ client: 'openai' })),
  mockGenerateOpenAIResponse: vi.fn(),
  mockStreamOpenAIResponse: vi.fn(),
}));

vi.mock('../../src/openai-direct.js', async () => {
  const actual = await vi.importActual('../../src/openai-direct.js');
  return {
    ...(actual as object),
    createClientForProvider: mockCreateClientForProvider,
    generateOpenAIResponse: mockGenerateOpenAIResponse,
    streamOpenAIResponse: mockStreamOpenAIResponse,
  };
});

import {
  type RuntimeCompleteResult,
  type RuntimeCompleteStatus,
  type RuntimeStreamCompleteEvent,
  createAskUserInputResult,
  createHumanInputToolResult,
} from '../../src/runtime-complete-contract.js';
import {
  createRuntime,
  executeToolCall,
  executeToolCalls,
  resolveTools,
} from '../../src/runtime.js';
import { intersectBuiltInToolSelections } from '../../src/builtins.js';
import { parseMCPConfigJson } from '../../src/mcp.js';
import type { LLMEnvironmentOptions } from '../../src/types.js';
import type { SkillFileSystemAdapter } from '../../src/skills.js';
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

    const finalAnswerCall = {
      id: 'final-1',
      type: 'function' as const,
      function: {
        name: 'final_answer',
        arguments: '{"answer":"TOKEN=project-token"}',
      },
    };

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
        type: 'tool_calls',
        content: '',
        tool_calls: [finalAnswerCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [finalAnswerCall],
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

  it('returns final diagnostic text when runtime.complete stops repeated tool calls', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const lookupToolCall = {
      id: 'lookup-repeat-1',
      type: 'function' as const,
      function: {
        name: 'project_lookup',
        arguments: '{"query":"token"}',
      },
    };
    const executeLookup = vi.fn(async () => ({ token: 'project-token' }));

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
      messages: [{ role: 'user', content: 'Find the token.' }],
      repeatedToolCallGuard: { maxConsecutiveSameBatches: 1 },
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

    expect(result.status).toBe('completed');
    expect(result.output).toContain('kept repeating the same tool call');
    expect(result.output).toContain('project_lookup');
    expect(result.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'assistant',
      content: result.output,
    }));
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(3);
    expect(executeLookup).toHaveBeenCalledTimes(1);

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

  it('keeps retrying plain assistant narration until maxIterations is reached', async () => {
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
      maxIterations: 4,
    });

    expect(result.status).toBe('max_iterations');
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(4);

    await runtime.dispose();
  });

  it('keeps looping when assistant text stopped for length after read-only evidence', async () => {
    await withTempWorkspace(async (workspacePath) => {
      mockGenerateOpenAIResponse.mockReset();
      await fs.writeFile(path.join(workspacePath, 'notes.txt'), 'contents');

      const readToolCall = {
        id: 'read-continue-1',
        type: 'function' as const,
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ filePath: 'notes.txt' }),
        },
      };

      const finalAnswerCall = {
        id: 'read-continue-final-1',
        type: 'function' as const,
        function: {
          name: 'final_answer',
          arguments: JSON.stringify({ answer: 'The file contains contents.' }),
        },
      };

      mockGenerateOpenAIResponse
        .mockResolvedValueOnce({
          type: 'tool_calls',
          content: '',
          tool_calls: [readToolCall],
          assistantMessage: {
            role: 'assistant',
            content: '',
            tool_calls: [readToolCall],
          },
        })
        .mockResolvedValueOnce({
          type: 'text',
          content: 'Please wait while I analyze the file.',
          assistantMessage: {
            role: 'assistant',
            content: 'Please wait while I analyze the file.',
          },
          stopKind: 'length',
          providerStopReason: 'length',
        })
        .mockResolvedValueOnce({
          type: 'tool_calls',
          content: '',
          tool_calls: [finalAnswerCall],
          assistantMessage: {
            role: 'assistant',
            content: '',
            tool_calls: [finalAnswerCall],
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
        messages: [{ role: 'user', content: 'Inspect notes.txt.' }],
        context: {
          workingDirectory: workspacePath,
        },
      });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('The file contains contents.');
      expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(3);

      await runtime.dispose();
    });
  });

  it('handles ask_user_input alongside other runtime tool calls without special pausing', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const executeLookup = vi.fn(async () => ({ token: 'project-token' }));
    const executeAskUserInput = vi.fn(async () => ({ pending: true }));
    const toolCalls = [
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
    ];

    const finalAnswerCall = {
      id: 'mixed-final-1',
      type: 'function' as const,
      function: {
        name: 'final_answer',
        arguments: '{"answer":"done"}',
      },
    };

    mockGenerateOpenAIResponse.mockImplementation(async (request: any) => {
      const toolResultIds = request.messages
        .filter((message: any) => message.role === 'tool')
        .map((message: any) => message.tool_call_id);

      if (toolResultIds.includes('lookup-mixed-1') && toolResultIds.includes('hitl-mixed-1')) {
        return {
          type: 'tool_calls',
          content: '',
          tool_calls: [finalAnswerCall],
          assistantMessage: {
            role: 'assistant',
            content: '',
            tool_calls: [finalAnswerCall],
          },
        };
      }

      return {
        type: 'tool_calls',
        content: '',
        tool_calls: toolCalls,
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: toolCalls,
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
      messages: [{ role: 'user', content: 'Find the token and ask me about scope.' }],
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
      }, {
        name: 'ask_user_input',
        description: 'Host-owned user input tool.',
        parameters: {
          type: 'object',
          properties: {
            questions: { type: 'array' },
          },
          required: ['questions'],
          additionalProperties: false,
        },
        execute: executeAskUserInput,
      }],
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('done');
    expect(executeLookup).toHaveBeenCalledTimes(1);
    expect(executeAskUserInput).toHaveBeenCalledTimes(1);
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });

  it('returns default ask_user_input tool calls to the host without executing a runtime HITL wait', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const askToolCall = {
      id: 'hitl-default-1',
      type: 'function' as const,
      function: {
        name: 'ask_user_input',
        arguments: '{"questions":[{"header":"Scope","id":"scope","question":"Which scope?","options":[{"id":"all","label":"All"},{"id":"one","label":"One"}]}]}',
      },
    };

    mockGenerateOpenAIResponse.mockImplementation(async (request: any) => {
      expect(request.tools.ask_user_input).toEqual(expect.objectContaining({ name: 'ask_user_input' }));
      return {
        type: 'tool_calls',
        content: '',
        tool_calls: [askToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [askToolCall],
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
      messages: [{ role: 'user', content: 'Ask me about scope.' }],
    });

    expect(result.status).toBe('tool_calls');
    expect(result.toolCalls).toEqual([askToolCall]);
    expect(result.messages).toEqual([
      { role: 'user', content: 'Ask me about scope.' },
      expect.objectContaining({ role: 'assistant', tool_calls: [askToolCall] }),
    ]);
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
      emptyTextRetryLimit: 0,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Assistant returned neither tool calls nor non-empty text.');
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  it('recovers from an empty assistant response after load_skill and continues with read_file', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-runtime-skill-root-'));

    try {
      const skillPath = path.join(skillRoot, 'agent-world-skill');
      await fs.mkdir(skillPath, { recursive: true });
      await fs.writeFile(
        path.join(skillPath, 'SKILL.md'),
        [
          '---',
          'name: agent-world-skill',
          'description: Agent World skill',
          '---',
          '# Agent World',
          '',
          'Read init-agent-world.md before initializing.',
        ].join('\n'),
      );
      await fs.writeFile(path.join(skillPath, 'init-agent-world.md'), 'agent world init reference');

      const loadSkillToolCall = {
        id: 'load-agent-world-1',
        type: 'function' as const,
        function: {
          name: 'load_skill',
          arguments: JSON.stringify({ skill_id: 'agent-world-skill' }),
        },
      };
      const readFileToolCall = {
        id: 'read-init-agent-world-1',
        type: 'function' as const,
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ filePath: 'init-agent-world.md' }),
        },
      };
      const seenRequests: any[] = [];

      mockGenerateOpenAIResponse.mockImplementation(async (request: any) => {
        seenRequests.push(request);
        const hasLoadedSkill = request.messages.some((message: any) => (
          message.role === 'tool'
          && message.tool_call_id === 'load-agent-world-1'
          && String(message.content ?? '').includes('<skill_root>')
        ));
        const hasReadInitReference = request.messages.some((message: any) => (
          message.role === 'tool'
          && message.tool_call_id === 'read-init-agent-world-1'
          && String(message.content ?? '').includes('agent world init reference')
        ));

        if (!hasLoadedSkill) {
          return {
            type: 'tool_calls',
            content: '',
            tool_calls: [loadSkillToolCall],
            assistantMessage: {
              role: 'assistant',
              content: '',
              tool_calls: [loadSkillToolCall],
            },
          };
        }

        if (!hasReadInitReference && seenRequests.length === 2) {
          return {
            type: 'text',
            content: '',
            assistantMessage: {
              role: 'assistant',
              content: '',
            },
          };
        }

        if (!hasReadInitReference) {
          return {
            type: 'tool_calls',
            content: '',
            tool_calls: [readFileToolCall],
            assistantMessage: {
              role: 'assistant',
              content: '',
              tool_calls: [readFileToolCall],
            },
          };
        }

        const finalAnswerCall = {
          id: 'agent-world-final-1',
          type: 'function' as const,
          function: {
            name: 'final_answer',
            arguments: JSON.stringify({ answer: 'Read the init reference.' }),
          },
        };
        return {
          type: 'tool_calls',
          content: '',
          tool_calls: [finalAnswerCall],
          assistantMessage: {
            role: 'assistant',
            content: '',
            tool_calls: [finalAnswerCall],
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
        messages: [{ role: 'user', content: 'agent world init' }],
        skillRoots: [skillRoot],
      });

      expect(result).toMatchObject({
        status: 'completed',
        output: 'Read the init reference.',
      });
      expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(4);
      expect(String(seenRequests[2]?.messages?.at(-1)?.content ?? '')).toContain('previous response had no final text');
      expect(result.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'load-agent-world-1',
          content: expect.stringContaining('<next_step>'),
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'read-init-agent-world-1',
          content: expect.stringContaining('agent world init reference'),
        }),
      ]));

      await runtime.dispose();
    } finally {
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  });

  it('defaults runtime.complete to read-only plus ask_user_input built-ins and passes request context into completion-loop tools', async () => {
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
      expect(request.tools.ask_user_input).toEqual(expect.objectContaining({ name: 'ask_user_input' }));
      expect(request.tools.read_file).toEqual(expect.objectContaining({ name: 'read_file' }));

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

      const finalAnswerCall = {
        id: 'lookup-context-final-1',
        type: 'function' as const,
        function: {
          name: 'final_answer',
          arguments: '{"answer":"done"}',
        },
      };

      return {
        type: 'tool_calls',
        content: '',
        tool_calls: [finalAnswerCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [finalAnswerCall],
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
    const status: RuntimeCompleteStatus = 'tool_calls';
    const result: RuntimeCompleteResult = {
      status,
      messages: [],
      toolCalls: [],
    };
    const event: RuntimeStreamCompleteEvent = {
      type: 'tool_calls',
      result,
      iteration: 1,
    };

    expect(result.toolCalls).toEqual([]);
    expect(event.type).toBe('tool_calls');
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
    mockStreamOpenAIResponse.mockReset();

    const lookupToolCall = {
      id: 'lookup-2',
      type: 'function' as const,
      function: {
        name: 'project_lookup',
        arguments: '{"query":"token"}',
      },
    };

    mockStreamOpenAIResponse.mockImplementation(async (request: any) => {
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

      const finalAnswerCall = {
        id: 'stream-final-1',
        type: 'function' as const,
        function: {
          name: 'final_answer',
          arguments: '{"answer":"TOKEN=project-token"}',
        },
      };

      request.onChunk({ content: 'TOKEN=' });
      request.onChunk({ reasoningContent: 'private reasoning' });
      request.onChunk({ content: 'project-token' });
      return {
        type: 'tool_calls',
        content: '',
        tool_calls: [finalAnswerCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [finalAnswerCall],
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
    const textDeltaEvents: RuntimeStreamCompleteEvent[] = [];
    const reasoningDeltaEvents: RuntimeStreamCompleteEvent[] = [];

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
      if (event.type === 'text_delta') {
        textDeltaEvents.push(event);
      }
      if (event.type === 'reasoning_delta') {
        reasoningDeltaEvents.push(event);
      }
    }

    expect(eventTypes).toEqual([
      'model_start',
      'assistant_message',
      'tool_start',
      'tool_result',
      'model_start',
      'text_delta',
      'reasoning_delta',
      'text_delta',
      'assistant_message',
      'completed',
    ]);
    expect(textDeltaEvents).toEqual([
      { type: 'text_delta', delta: 'TOKEN=', iteration: 2 },
      { type: 'text_delta', delta: 'project-token', iteration: 2 },
    ]);
    expect(reasoningDeltaEvents).toEqual([
      { type: 'reasoning_delta', delta: 'private reasoning', iteration: 2 },
    ]);
    expect(mockGenerateOpenAIResponse).not.toHaveBeenCalled();
    expect(mockStreamOpenAIResponse).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });

  it('emits text and reasoning deltas from runtime.streamComplete separately', async () => {
    mockGenerateOpenAIResponse.mockReset();
    mockStreamOpenAIResponse.mockReset();

    const finalAnswerCall = {
      id: 'hello-final-1',
      type: 'function' as const,
      function: {
        name: 'final_answer',
        arguments: '{"answer":"hello"}',
      },
    };

    mockStreamOpenAIResponse.mockImplementation(async (request: any) => {
      request.onChunk({ content: 'hel' });
      request.onChunk({ reasoningContent: 'hidden chain' });
      request.onChunk({ content: 'lo' });
      return {
        type: 'tool_calls',
        content: '',
        tool_calls: [finalAnswerCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [finalAnswerCall],
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

    const events: RuntimeStreamCompleteEvent[] = [];

    for await (const event of runtime.streamComplete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Say hello.' }],
      defaultTextResponseMode: 'permissive',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'model_start', iteration: 1 },
      { type: 'text_delta', delta: 'hel', iteration: 1 },
      { type: 'reasoning_delta', delta: 'hidden chain', iteration: 1 },
      { type: 'text_delta', delta: 'lo', iteration: 1 },
      expect.objectContaining({ type: 'assistant_message', iteration: 1 }),
      expect.objectContaining({
        type: 'completed',
        iteration: 1,
        result: expect.objectContaining({ status: 'completed', output: 'hello' }),
      }),
    ]);
    expect(mockGenerateOpenAIResponse).not.toHaveBeenCalled();
    expect(mockStreamOpenAIResponse).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  it('keeps streamComplete retrying plain assistant narration until maxIterations is reached', async () => {
    mockGenerateOpenAIResponse.mockReset();
    mockStreamOpenAIResponse.mockReset();

    mockStreamOpenAIResponse.mockResolvedValue({
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

    let finalEvent: RuntimeStreamCompleteEvent | undefined;

    for await (const event of runtime.streamComplete({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Inspect the project files.' }],
      maxIterations: 4,
    })) {
      finalEvent = event;
    }

    expect(finalEvent).toEqual(expect.objectContaining({
      type: 'failed',
      result: expect.objectContaining({
        status: 'max_iterations',
      }),
    }));
    expect(mockGenerateOpenAIResponse).not.toHaveBeenCalled();
    expect(mockStreamOpenAIResponse).toHaveBeenCalledTimes(4);

    await runtime.dispose();
  });

  it('continues past non-English plain text in control-tool termination mode', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const lookupToolCall = {
      id: 'lookup-control-1',
      type: 'function' as const,
      function: {
        name: 'project_lookup',
        arguments: '{"query":"token"}',
      },
    };
    const finalAnswerToolCall = {
      id: 'control-final-1',
      type: 'function' as const,
      function: {
        name: 'final_answer',
        arguments: '{"answer":"完成了"}',
      },
    };

    mockGenerateOpenAIResponse
      .mockResolvedValueOnce({
        type: 'text',
        content: '我先看一下。',
        assistantMessage: {
          role: 'assistant',
          content: '我先看一下。',
        },
      })
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [lookupToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [lookupToolCall],
        },
      })
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [finalAnswerToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [finalAnswerToolCall],
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
      messages: [{ role: 'user', content: 'Find the token.' }],
      extraTools: [{
        name: 'project_lookup',
        description: 'Lookup the project token.',
        evidenceKind: 'read',
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

    expect(result.status).toBe('completed');
    expect(result.output).toBe('完成了');
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(3);

    await runtime.dispose();
  });

  it('continues past post-tool future-work narration until the model calls final_answer', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const inspectToolCall = {
      id: 'inspect-agent-world-1',
      type: 'function' as const,
      function: {
        name: 'project_lookup',
        arguments: '{"query":"agent-world"}',
      },
    };
    const finalAnswerToolCall = {
      id: 'control-final-agent-world-1',
      type: 'function' as const,
      function: {
        name: 'final_answer',
        arguments: '{"answer":"Created the Agent World files."}',
      },
    };
    const futureWorkNarration = [
      'Agent World initialization will use:',
      '',
      '**Pattern:** Broadcast',
      '_One message can wake all eligible active agents._',
      '',
      'Next, I will:',
      '',
      '- Create `.agent-world/`',
      '- Create `.agent-world/prompts/`',
      '- Generate prompt files',
      '',
      'Proceeding with world creation now.',
    ].join('\n');

    mockGenerateOpenAIResponse
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [inspectToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [inspectToolCall],
        },
      })
      .mockResolvedValueOnce({
        type: 'text',
        content: futureWorkNarration,
        stopKind: 'natural_stop',
        providerStopReason: 'stop',
        assistantMessage: {
          role: 'assistant',
          content: futureWorkNarration,
        },
      })
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [finalAnswerToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [finalAnswerToolCall],
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
      messages: [{ role: 'user', content: 'Initialize Agent World.' }],
      extraTools: [{
        name: 'project_lookup',
        description: 'Inspect Agent World state.',
        evidenceKind: 'read',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async () => ({ exists: false }),
      }],
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Created the Agent World files.');
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(3);

    await runtime.dispose();
  });

  it('does not accept successful initialization text before a mutating tool result exists', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const inspectToolCall = {
      id: 'inspect-world-1',
      type: 'function' as const,
      function: {
        name: 'inspect_world',
        arguments: '{}',
      },
    };
    const writeToolCall = {
      id: 'write-world-1',
      type: 'function' as const,
      function: {
        name: 'write_world_file',
        arguments: '{"path":".agent-world/world.json"}',
      },
    };
    const unsupportedSuccess = [
      'Agent World has been successfully initialized.',
      '',
      'You can now start using it by sending your first world message.',
    ].join('\n');
    const executeInspect = vi.fn(async () => ({ exists: false }));
    const executeWrite = vi.fn(async () => ({ ok: true }));

    mockGenerateOpenAIResponse
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [inspectToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [inspectToolCall],
        },
      })
      .mockResolvedValueOnce({
        type: 'text',
        content: unsupportedSuccess,
        stopKind: 'natural_stop',
        providerStopReason: 'stop',
        assistantMessage: {
          role: 'assistant',
          content: unsupportedSuccess,
        },
      })
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [writeToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [writeToolCall],
        },
      })
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [{
          id: 'init-world-final-1',
          type: 'function' as const,
          function: {
            name: 'final_answer',
            arguments: JSON.stringify({ answer: 'Agent World has been successfully initialized.' }),
          },
        }],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'init-world-final-1',
            type: 'function' as const,
            function: {
              name: 'final_answer',
              arguments: JSON.stringify({ answer: 'Agent World has been successfully initialized.' }),
            },
          }],
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
      messages: [{ role: 'user', content: 'Initialize Agent World.' }],
      extraTools: [{
        name: 'inspect_world',
        description: 'Inspect world state.',
        evidenceKind: 'read',
        parameters: { type: 'object' },
        execute: executeInspect,
      }, {
        name: 'write_world_file',
        description: 'Write world files.',
        evidenceKind: 'write',
        parameters: { type: 'object' },
        execute: executeWrite,
      }],
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Agent World has been successfully initialized.');
    expect(executeInspect).toHaveBeenCalledTimes(1);
    expect(executeWrite).toHaveBeenCalledTimes(1);
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(4);

    await runtime.dispose();
  });

  it('does not accept final_answer before a mutating tool result exists', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const prematureFinalToolCall = {
      id: 'control-final-before-write-1',
      type: 'function' as const,
      function: {
        name: 'final_answer',
        arguments: '{"answer":"Agent World has been successfully initialized."}',
      },
    };
    const writeToolCall = {
      id: 'write-world-before-final-1',
      type: 'function' as const,
      function: {
        name: 'write_world_file',
        arguments: '{"path":".agent-world/world.json"}',
      },
    };
    const finalToolCall = {
      id: 'control-final-after-write-1',
      type: 'function' as const,
      function: {
        name: 'final_answer',
        arguments: '{"answer":"Agent World has been successfully initialized."}',
      },
    };
    const executeWrite = vi.fn(async () => ({ ok: true }));

    mockGenerateOpenAIResponse
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [prematureFinalToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [prematureFinalToolCall],
        },
      })
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [writeToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [writeToolCall],
        },
      })
      .mockResolvedValueOnce({
        type: 'tool_calls',
        content: '',
        tool_calls: [finalToolCall],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [finalToolCall],
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
      messages: [{ role: 'user', content: 'Initialize Agent World.' }],
      extraTools: [{
        name: 'write_world_file',
        description: 'Write world files.',
        evidenceKind: 'write',
        parameters: { type: 'object' },
        execute: executeWrite,
      }],
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: 'Agent World has been successfully initialized.',
    });
    expect(executeWrite).toHaveBeenCalledTimes(1);
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledTimes(3);

    await runtime.dispose();
  });

  it('maps final_answer control tool calls without executing them as normal tools', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const executeLookup = vi.fn();
    const finalAnswerToolCall = {
      id: 'control-final-direct-1',
      type: 'function' as const,
      function: {
        name: 'final_answer',
        arguments: '{"answer":"Verified result"}',
      },
    };

    mockGenerateOpenAIResponse.mockResolvedValue({
      type: 'tool_calls',
      content: '',
      tool_calls: [finalAnswerToolCall],
      assistantMessage: {
        role: 'assistant',
        content: '',
        tool_calls: [finalAnswerToolCall],
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
      messages: [{ role: 'user', content: 'Finish.' }],
      extraTools: [{
        name: 'project_lookup',
        description: 'Lookup.',
        parameters: { type: 'object' },
        execute: executeLookup,
      }],
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: 'Verified result',
    });
    expect(executeLookup).not.toHaveBeenCalled();

    await runtime.dispose();
  });

  it('maps need_user_input control tool calls to host-actionable tool_calls', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const needInputToolCall = {
      id: 'control-input-1',
      type: 'function' as const,
      function: {
        name: 'need_user_input',
        arguments: '{"question":"Which account?","reason":"A target account is required."}',
      },
    };

    mockGenerateOpenAIResponse.mockResolvedValue({
      type: 'tool_calls',
      content: '',
      tool_calls: [needInputToolCall],
      assistantMessage: {
        role: 'assistant',
        content: '',
        tool_calls: [needInputToolCall],
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
      messages: [{ role: 'user', content: 'Find the account.' }],
    });

    expect(result.status).toBe('tool_calls');
    expect(result.toolCalls).toEqual([needInputToolCall]);
    expect(result.toolCalls?.[0]?.function.arguments).toContain('Which account?');

    await runtime.dispose();
  });

  it('maps blocked control tool calls to failed results with the reason preserved', async () => {
    mockGenerateOpenAIResponse.mockReset();

    const blockedToolCall = {
      id: 'control-blocked-1',
      type: 'function' as const,
      function: {
        name: 'blocked',
        arguments: '{"reason":"Missing permission."}',
      },
    };

    mockGenerateOpenAIResponse.mockResolvedValue({
      type: 'tool_calls',
      content: '',
      tool_calls: [blockedToolCall],
      assistantMessage: {
        role: 'assistant',
        content: '',
        tool_calls: [blockedToolCall],
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
      messages: [{ role: 'user', content: 'Do restricted work.' }],
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Missing permission.',
    });

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

  it('reads files without a fixed hard line cap when limit is explicit', async () => {
    await withTempWorkspace(async (workspacePath) => {
      const lines = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`);
      await fs.writeFile(path.join(workspacePath, 'long.txt'), lines.join('\n'));

      const tools = resolveTools({
        builtIns: {
          read_file: true,
        },
      });

      const result = await tools.read_file?.execute?.({
        filePath: 'long.txt',
        limit: 250,
      }, {
        workingDirectory: workspacePath,
      });
      const parsed = JSON.parse(String(result));

      expect(parsed).toMatchObject({
        filePath: path.join(workspacePath, 'long.txt'),
        offset: 1,
        limit: 250,
        totalLines: 250,
      });
      expect(parsed.content.split('\n')).toHaveLength(250);
      expect(parsed.content.split('\n').at(-1)).toBe('line-250');
    });
  });

  it('keeps read_file scoped to the trusted working directory', async () => {
    await withTempWorkspace(async (workspacePath) => {
      const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-runtime-skill-'));

      try {
        const skillPath = path.join(skillRoot, 'sample-skill');
        await fs.mkdir(skillPath, { recursive: true });
        await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Sample skill\n\nUsed for test discovery.');
        await fs.writeFile(path.join(skillPath, 'external.txt'), 'outside workspace file');

        const result = await executeToolCall({
          toolCall: {
            id: 'tool-read-scope-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ filePath: 'external.txt' }),
            },
          },
          builtIns: {
            read_file: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
          },
        });

        const parsedResult = JSON.parse(String(result));
        expect(parsedResult).toEqual(expect.objectContaining({
          ok: false,
          status: 'error',
          errorType: 'read_only_file_tool_failed',
          toolName: 'read_file',
          code: 'not_found',
          requestedPath: 'external.txt',
        }));
        expect(parsedResult.message).toContain('ENOENT');
        expect(parsedResult.recovery).toEqual(expect.objectContaining({
          avoidTools: ['shell_cmd'],
        }));

        const absoluteResult = await executeToolCall({
          toolCall: {
            id: 'tool-read-scope-absolute-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ filePath: path.join(skillPath, 'external.txt') }),
            },
          },
          builtIns: {
            read_file: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
          },
        });
        const parsedAbsoluteResult = JSON.parse(String(absoluteResult));

        expect(parsedAbsoluteResult).toEqual(expect.objectContaining({
          ok: false,
          status: 'error',
          errorType: 'read_only_file_tool_failed',
          toolName: 'read_file',
          code: 'path_scope_mismatch',
          requestedPath: path.join(skillPath, 'external.txt'),
        }));
        expect(parsedAbsoluteResult.recovery.instruction).toContain('call load_skill');
        expect(parsedAbsoluteResult.recovery.instruction).toContain('Do not recover by using shell_cmd');
      } finally {
        await fs.rm(skillRoot, { recursive: true, force: true });
      }
    });
  });

  it('resolves read_file, list_files, and search_files from a loaded skill root under skill context', async () => {
    await withTempWorkspace(async (workspacePath) => {
      const fakeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-runtime-home-'));
      const skillRoot = path.join(fakeHomePath, '.agents', 'skills');

      try {
        const skillPath = path.join(skillRoot, 'sample-skill');
        await fs.mkdir(path.join(skillPath, 'references'), { recursive: true });
        await fs.writeFile(
          path.join(skillPath, 'SKILL.md'),
          '---\nname: sample-skill\ndescription: Sample skill\n---\n# Sample skill\n\nRead references/guide.md. Before setup, read `init-agent-world.md`.',
        );
        await fs.writeFile(path.join(skillPath, 'references', 'guide.md'), 'skill-owned guide');
        await fs.writeFile(path.join(skillPath, 'init-agent-world.md'), 'skill init guide');
        await fs.mkdir(path.join(skillPath, 'notes'), { recursive: true });
        await fs.writeFile(path.join(skillPath, 'notes', 'unmentioned.md'), 'skill unmentioned note');

        await fs.mkdir(path.join(workspacePath, 'references'), { recursive: true });
        await fs.writeFile(path.join(workspacePath, 'references', 'guide.md'), 'workspace guide');
        await fs.mkdir(path.join(workspacePath, 'notes'), { recursive: true });
        await fs.writeFile(path.join(workspacePath, 'notes', 'unmentioned.md'), 'workspace unmentioned note');

        const loadSkillResult = await executeToolCall({
          toolCall: {
            id: 'tool-load-skill-root-1',
            type: 'function',
            function: {
              name: 'load_skill',
              arguments: JSON.stringify({ skill_id: 'sample-skill' }),
            },
          },
          builtIns: {
            load_skill: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
          },
        });
        expect(String(loadSkillResult)).toContain('<next_step>');
        expect(String(loadSkillResult)).toContain('continue immediately');
        expect(String(loadSkillResult)).toContain('call read_file, list_files, or search_files as needed');
        const loadedSkillMessages = [
          {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{
              id: 'tool-load-skill-root-1',
              type: 'function' as const,
              function: {
                name: 'load_skill',
                arguments: JSON.stringify({ skill_id: 'sample-skill' }),
              },
            }],
          },
          {
            role: 'tool' as const,
            tool_call_id: 'tool-load-skill-root-1',
            content: String(loadSkillResult),
          },
        ];

        const readResult = await executeToolCall({
          toolCall: {
            id: 'tool-read-skill-root-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ filePath: 'references/guide.md' }),
            },
          },
          builtIns: {
            read_file: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedReadResult = JSON.parse(String(readResult));

        expect(parsedReadResult.filePath).toBe(path.join(skillPath, 'references', 'guide.md'));
        expect(parsedReadResult.content).toBe('skill-owned guide');

        const absoluteReadResult = await executeToolCall({
          toolCall: {
            id: 'tool-read-absolute-skill-root-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ filePath: path.join(skillPath, 'init-agent-world.md') }),
            },
          },
          builtIns: {
            read_file: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedAbsoluteReadResult = JSON.parse(String(absoluteReadResult));

        expect(parsedAbsoluteReadResult.filePath).toBe(path.join(skillPath, 'init-agent-world.md'));
        expect(parsedAbsoluteReadResult.content).toBe('skill init guide');

        const registeredSkillReferenceReadResult = await executeToolCall({
          toolCall: {
            id: 'tool-read-registered-skill-reference-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ filePath: 'init-agent-world.md' }),
            },
          },
          builtIns: {
            read_file: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
          },
        });
        const parsedRegisteredSkillReferenceReadResult = JSON.parse(String(registeredSkillReferenceReadResult));

        expect(parsedRegisteredSkillReferenceReadResult.filePath).toBe(path.join(skillPath, 'init-agent-world.md'));
        expect(parsedRegisteredSkillReferenceReadResult.content).toBe('skill init guide');

        const relativeSkillFileReadResult = await executeToolCall({
          toolCall: {
            id: 'tool-read-existing-skill-relative-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ filePath: 'init-agent-world.md' }),
            },
          },
          builtIns: {
            read_file: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedRelativeSkillFileReadResult = JSON.parse(String(relativeSkillFileReadResult));

        expect(parsedRelativeSkillFileReadResult.filePath).toBe(path.join(skillPath, 'init-agent-world.md'));
        expect(parsedRelativeSkillFileReadResult.content).toBe('skill init guide');

        const workspaceFallbackReadResult = await executeToolCall({
          toolCall: {
            id: 'tool-read-workspace-fallback-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ filePath: 'notes/unmentioned.md' }),
            },
          },
          builtIns: {
            read_file: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedWorkspaceFallbackReadResult = JSON.parse(String(workspaceFallbackReadResult));

        expect(parsedWorkspaceFallbackReadResult.filePath).toBe(path.join(workspacePath, 'notes', 'unmentioned.md'));
        expect(parsedWorkspaceFallbackReadResult.content).toBe('workspace unmentioned note');

        const listResult = await executeToolCall({
          toolCall: {
            id: 'tool-list-skill-root-1',
            type: 'function',
            function: {
              name: 'list_files',
              arguments: JSON.stringify({ path: 'references' }),
            },
          },
          builtIns: {
            list_files: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedListResult = JSON.parse(String(listResult));

        expect(parsedListResult).toEqual(expect.objectContaining({
          path: path.join(skillPath, 'references'),
          entries: ['guide.md'],
        }));

        const absoluteListResult = await executeToolCall({
          toolCall: {
            id: 'tool-list-absolute-skill-root-1',
            type: 'function',
            function: {
              name: 'list_files',
              arguments: JSON.stringify({ path: skillPath }),
            },
          },
          builtIns: {
            list_files: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedAbsoluteListResult = JSON.parse(String(absoluteListResult));

        expect(parsedAbsoluteListResult).toEqual(expect.objectContaining({
          path: skillPath,
          entries: expect.arrayContaining(['SKILL.md', 'init-agent-world.md', 'references/']),
        }));

        const registeredSkillAliasListResult = await executeToolCall({
          toolCall: {
            id: 'tool-list-registered-skill-alias-1',
            type: 'function',
            function: {
              name: 'list_files',
              arguments: JSON.stringify({ path: 'sample-skill' }),
            },
          },
          builtIns: {
            list_files: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
          },
        });
        const parsedRegisteredSkillAliasListResult = JSON.parse(String(registeredSkillAliasListResult));

        expect(parsedRegisteredSkillAliasListResult).toEqual(expect.objectContaining({
          path: skillPath,
          entries: expect.arrayContaining(['SKILL.md', 'init-agent-world.md', 'references/']),
        }));

        const skillAliasListResult = await executeToolCall({
          toolCall: {
            id: 'tool-list-skill-alias-1',
            type: 'function',
            function: {
              name: 'list_files',
              arguments: JSON.stringify({ path: 'sample-skill' }),
            },
          },
          builtIns: {
            list_files: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedSkillAliasListResult = JSON.parse(String(skillAliasListResult));

        expect(parsedSkillAliasListResult).toEqual(expect.objectContaining({
          path: skillPath,
          entries: expect.arrayContaining(['SKILL.md', 'init-agent-world.md', 'references/']),
        }));

        const searchResult = await executeToolCall({
          toolCall: {
            id: 'tool-search-skill-root-1',
            type: 'function',
            function: {
              name: 'search_files',
              arguments: JSON.stringify({
                path: 'references',
                pattern: '*.md',
              }),
            },
          },
          builtIns: {
            search_files: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedSearchResult = JSON.parse(String(searchResult));

        expect(parsedSearchResult).toEqual(expect.objectContaining({
          path: path.join(skillPath, 'references'),
          entries: ['guide.md'],
        }));

        const absoluteSearchResult = await executeToolCall({
          toolCall: {
            id: 'tool-search-absolute-skill-root-1',
            type: 'function',
            function: {
              name: 'search_files',
              arguments: JSON.stringify({
                path: skillPath,
                pattern: '*.md',
              }),
            },
          },
          builtIns: {
            search_files: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedAbsoluteSearchResult = JSON.parse(String(absoluteSearchResult));

        expect(parsedAbsoluteSearchResult).toEqual(expect.objectContaining({
          path: skillPath,
          entries: expect.arrayContaining(['SKILL.md', 'init-agent-world.md']),
        }));

        const createResult = await executeToolCall({
          toolCall: {
            id: 'tool-create-workspace-root-1',
            type: 'function',
            function: {
              name: 'create_directory',
              arguments: JSON.stringify({ path: 'references/generated' }),
            },
          },
          builtIns: {
            create_directory: true,
          },
          skillRoots: [skillRoot],
          context: {
            workingDirectory: workspacePath,
            messages: loadedSkillMessages,
          },
        });
        const parsedCreateResult = JSON.parse(String(createResult));

        expect(parsedCreateResult.path).toBe(path.join(workspacePath, 'references', 'generated'));
        await expect(fs.access(path.join(skillPath, 'references', 'generated'))).rejects.toThrow();
      } finally {
        await fs.rm(fakeHomePath, { recursive: true, force: true });
      }
    });
  });

  it('lists hidden and previously excluded paths only when requested', async () => {
    await withTempWorkspace(async (workspacePath) => {
      await fs.mkdir(path.join(workspacePath, '.git'), { recursive: true });
      await fs.mkdir(path.join(workspacePath, 'node_modules', 'demo'), { recursive: true });
      await fs.writeFile(path.join(workspacePath, '.env'), 'SECRET=1');
      await fs.writeFile(path.join(workspacePath, '.git', 'config'), '[core]');
      await fs.writeFile(path.join(workspacePath, 'node_modules', 'demo', 'index.js'), 'export {};');

      const tools = resolveTools({
        builtIns: {
          list_files: true,
          search_files: true,
        },
      });

      const defaultList = JSON.parse(String(await tools.list_files?.execute?.({}, {
        workingDirectory: workspacePath,
      })));
      expect(defaultList.entries).not.toContain('.env');
      expect(defaultList.entries).not.toContain('.git/');
      expect(defaultList.entries).toContain('node_modules/');

      const hiddenList = JSON.parse(String(await tools.list_files?.execute?.({
        includeHidden: true,
        recursive: true,
        maxDepth: 3,
      }, {
        workingDirectory: workspacePath,
      })));
      expect(hiddenList.entries).toEqual(expect.arrayContaining([
        '.env',
        '.git/',
        '.git/config',
        'node_modules/',
        'node_modules/demo/',
      ]));

      const defaultSearch = JSON.parse(String(await tools.search_files?.execute?.({
        pattern: '**/*.js',
      }, {
        workingDirectory: workspacePath,
      })));
      expect(defaultSearch.entries).toEqual(['node_modules/demo/index.js']);

      const hiddenSearch = JSON.parse(String(await tools.search_files?.execute?.({
        pattern: '**/*.js',
        includeHidden: true,
      }, {
        workingDirectory: workspacePath,
      })));
      expect(hiddenSearch.entries).toEqual(['node_modules/demo/index.js']);
    });
  });

  it('writes files and validates missing target paths before execution', async () => {
    await withTempWorkspace(async (workspacePath) => {
      const tools = resolveTools({
        builtIns: {
          write_file: true,
        },
      });

      const result = await tools.write_file?.execute?.({
        path: 'notes/output.txt',
        content: 'hello write tool',
      }, {
        workingDirectory: workspacePath,
      });
      const parsed = JSON.parse(String(result));

      expect(parsed).toMatchObject({
        ok: true,
        status: 'success',
        mode: 'overwrite',
      });
      await expect(fs.readFile(path.join(workspacePath, 'notes', 'output.txt'), 'utf8')).resolves.toBe('hello write tool');

      const invalid = await tools.write_file?.execute?.({
        content: 'missing path',
      }, {
        workingDirectory: workspacePath,
      });

      expect(String(invalid)).toContain('"errorType": "tool_parameter_validation_failed"');
      expect(String(invalid)).toContain('Required parameter \'filePath\' is missing or empty');
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
        isSymbolicLink: false,
      });
    });
  });

  it('reports symlink-aware path existence semantics', async () => {
    await withTempWorkspace(async (workspacePath) => {
      await fs.writeFile(path.join(workspacePath, 'target.txt'), 'ready');
      await fs.symlink('target.txt', path.join(workspacePath, 'link.txt'));
      await fs.symlink('missing.txt', path.join(workspacePath, 'dangling.txt'));

      const tools = resolveTools({
        builtIns: {
          path_exists: true,
        },
      });

      const linkResult = JSON.parse(String(await tools.path_exists?.execute?.({
        path: 'link.txt',
      }, {
        workingDirectory: workspacePath,
      })));
      const danglingResult = JSON.parse(String(await tools.path_exists?.execute?.({
        path: 'dangling.txt',
      }, {
        workingDirectory: workspacePath,
      })));

      expect(linkResult).toMatchObject({
        exists: true,
        type: 'file',
        isFile: true,
        isDirectory: false,
        isSymbolicLink: true,
      });
      expect(danglingResult).toMatchObject({
        exists: true,
        type: 'other',
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
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

  it('rejects missing file paths for read_file during validation', async () => {
    const tools = resolveTools({
      builtIns: {
        read_file: true,
      },
    });

    const result = await tools.read_file?.execute?.({});

    expect(String(result)).toContain('"errorType": "tool_parameter_validation_failed"');
    expect(String(result)).toContain('Required parameter \'filePath\' is missing or empty');
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

  it('rejects attempts to override reserved operational built-in tool names', () => {
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

    expect(resolveTools({
      extraTools: [
        {
          name: 'ask_user_input',
          description: 'Host-owned user input tool.',
          parameters: { type: 'object' },
        },
      ],
    }).ask_user_input).toEqual(expect.objectContaining({
      name: 'ask_user_input',
      description: 'Host-owned user input tool.',
    }));
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
