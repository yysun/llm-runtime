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
 * - 2026-05-15: Added coverage for read-only built-in defaults, public tool execution helpers, deprecated alias exposure, and abort-aware built-ins.
 * - 2026-05-15: Added `createRuntime(...)` facade coverage and synchronized deprecated HITL alias coverage.
 * - 2026-03-27: Initial targeted coverage for the new `llm-runtime` package.
 * - 2026-03-27: Added runtime-scoped provider configuration regression coverage.
 * - 2026-03-27: Added built-in tool enablement, narrowing, and host-adapter coverage.
 * - 2026-05-14: Replaced `grep` coverage with filesystem built-in coverage for `search_files`, `create_directory`, and `path_exists`.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  createRuntime,
  createLLMEnvironment,
  disposeLLMEnvironment,
  executeToolCall,
  executeToolCalls,
  intersectBuiltInToolSelections,
  parseMCPConfigJson,
  resolveTools,
  type LLMEnvironmentOptions,
  type SkillFileSystemAdapter,
} from '../../src/index.js';

function pendingUserInputMatcher(requestId: string) {
  return expect.objectContaining({
    status: 'pending',
    pending: true,
    confirmed: false,
    terminalReason: 'pending_user_input',
    suspended: true,
    requestId,
  });
}

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

    const environment = createLLMEnvironment({
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
    const firstEnvironment = createLLMEnvironment({
      providers: {
        openai: {
          apiKey: 'first-openai-key',
        },
      },
    } satisfies LLMEnvironmentOptions);

    const secondEnvironment = createLLMEnvironment({
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
    const environment = createLLMEnvironment({
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

  it('creates a runtime facade with bound helpers while preserving the environment surface', async () => {
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
    expect(typeof runtime.stream).toBe('function');
    expect(typeof runtime.complete).toBe('function');
    expect(typeof runtime.resolveTools).toBe('function');
    expect(typeof runtime.executeToolCall).toBe('function');
    expect(typeof runtime.executeToolCalls).toBe('function');
    expect(typeof runtime.dispose).toBe('function');
    expect(Object.keys(runtime.resolveTools({ builtIns: { ask_user_input: true } }))).toEqual([
      'ask_user_input',
    ]);

    await expect(runtime.dispose()).resolves.toBeUndefined();
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

  it('exposes deprecated HITL aliases only when explicitly requested', () => {
    expect(Object.keys(resolveTools({ builtIns: { ask_user_input: true } }))).toEqual([
      'ask_user_input',
    ]);

    expect(Object.keys(resolveTools({
      builtIns: { ask_user_input: true },
      includeDeprecatedBuiltInAliases: true,
    })).sort()).toEqual([
      'ask_user_input',
      'ask_user_question',
      'human_intervention_request',
    ]);
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

  it('keeps ask_user_input and the deprecated HITL aliases synchronized', () => {
    const resolvedFromCanonical = resolveTools({
      builtIns: {
        human_intervention_request: true,
      },
    });

    expect(Object.keys(resolvedFromCanonical).sort()).toEqual(['ask_user_input']);

    const resolvedFromPreferred = resolveTools({
      builtIns: {
        ask_user_input: true,
      },
    });

    expect(Object.keys(resolvedFromPreferred).sort()).toEqual(['ask_user_input']);

    const resolvedFromDeprecatedAlias = resolveTools({
      builtIns: {
        ask_user_question: true,
      },
    });

    expect(Object.keys(resolvedFromDeprecatedAlias).sort()).toEqual(['ask_user_input']);
  });

  it('keeps the ask_user_input alias synchronized in built-in intersection helpers', () => {
    expect(intersectBuiltInToolSelections(true, {
      ask_user_input: true,
    })).toMatchObject({
      ask_user_input: true,
      ask_user_question: true,
      human_intervention_request: true,
    });

    expect(intersectBuiltInToolSelections(true, {
      human_intervention_request: true,
    })).toMatchObject({
      ask_user_input: true,
      ask_user_question: true,
      human_intervention_request: true,
    });

    expect(intersectBuiltInToolSelections(true, {
      ask_user_question: true,
    })).toMatchObject({
      ask_user_input: true,
      ask_user_question: true,
      human_intervention_request: true,
    });
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

  it('accepts deprecated HITL aliases during public tool execution when ask_user_input is enabled', async () => {
    const result = await executeToolCall({
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
    });

    expect(JSON.parse(String(result))).toEqual(expect.objectContaining({
      pending: true,
      requestId: 'tool-hitl-1',
    }));
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
      includeDeprecatedBuiltInAliases: true,
    });
    const result = await tools.human_intervention_request?.execute?.({
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
    expect(result).toContain('"terminalReason": "pending_user_input"');
    expect(result).toContain('"suspended": true');
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
      toolCallId: 'hitl-call-alias-1',
    });

    expect(result).toContain('"status": "pending"');
    expect(result).toContain('"terminalReason": "pending_user_input"');
    expect(result).toContain('"requestId": "hitl-call-alias-1"');
    expect(result).toContain('"question": "Continue?"');
  });

  it('lets ask_user_question execute the same HITL pending flow', async () => {
    const tools = resolveTools({
      builtIns: { ask_user_input: true },
      includeDeprecatedBuiltInAliases: true,
    });
    const result = await tools.ask_user_question?.execute?.({
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
      toolCallId: 'hitl-call-alias-2',
    });

    expect(result).toContain('"status": "pending"');
    expect(result).toContain('"terminalReason": "pending_user_input"');
    expect(result).toContain('"requestId": "hitl-call-alias-2"');
    expect(result).toContain('"question": "Continue?"');
  });

  it('exposes the structured ask_user_input choice schema on both HITL aliases', () => {
    const tools = resolveTools({
      builtIns: { ask_user_input: true },
      includeDeprecatedBuiltInAliases: true,
    });
    const askSchema = tools.ask_user_input?.parameters as any;
    const legacySchema = tools.human_intervention_request?.parameters as any;
    const deprecatedSchema = tools.ask_user_question?.parameters as any;

    expect(tools.ask_user_input?.description).toContain('Use questions[]');
    expect(tools.ask_user_input?.description).toContain('cannot be safely resolved through read-only lookup, search, or inspection');
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
    expect(legacySchema).toEqual(askSchema);
    expect(deprecatedSchema).toEqual(askSchema);
    expect(tools.human_intervention_request?.description).toContain('cannot be safely resolved through read-only lookup, search, or inspection');
    expect(tools.human_intervention_request?.description).toContain('Do not use allowSkip for approval-gated or otherwise blocking decisions');
    expect(tools.ask_user_question?.description).toContain('Prefer `ask_user_input` for new prompts');
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
    expect(parsed).toEqual(pendingUserInputMatcher('hitl-structured-1'));
    expect(parsed.type).toBe('single-select');
    expect(parsed.allowSkip).toBe(false);
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

  it('keeps both HITL aliases equivalent for structured calls', async () => {
    const tools = resolveTools({
      builtIns: { ask_user_input: true },
      includeDeprecatedBuiltInAliases: true,
    });
    const payload = {
      type: 'multiple-select',
      allowSkip: true,
      questions: [{
        header: 'Checks',
        id: 'checks',
        question: 'Which checks?',
        options: [
          { id: 'unit', label: 'Unit' },
          { id: 'types', label: 'Types' },
        ],
      }],
    };

    const askResult = JSON.parse(String(await tools.ask_user_input?.execute?.(payload, {
      toolCallId: 'ask-call',
    })));
    const legacyResult = JSON.parse(String(await tools.human_intervention_request?.execute?.(payload, {
      toolCallId: 'legacy-call',
    })));

    delete askResult.requestId;
    delete legacyResult.requestId;
    expect(legacyResult).toEqual(askResult);
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

  it('rejects removed HITL aliases before execution', async () => {
    const tools = resolveTools({
      builtIns: { ask_user_input: true },
      includeDeprecatedBuiltInAliases: true,
    });

    const aliasResult = await tools.human_intervention_request?.execute?.({
      prompt: 'Continue?',
      default_option: 'Yes',
    } as any);

    expect(aliasResult).toContain('"errorType": "tool_parameter_validation_failed"');
    expect(aliasResult).toContain('"path": "prompt"');
    expect(aliasResult).toContain('"code": "unknown_parameter"');
    expect(aliasResult).toContain("Unknown parameter 'prompt' is not allowed");
  });

  it('returns a durable validation artifact for missing required parameters', async () => {
    const tools = resolveTools({
      builtIns: { ask_user_input: true },
      includeDeprecatedBuiltInAliases: true,
    });

    const missingQuestionsResult = await tools.human_intervention_request?.execute?.({} as any);

    expect(missingQuestionsResult).toContain('"errorType": "tool_parameter_validation_failed"');
    expect(missingQuestionsResult).toContain('"path": "questions"');
    expect(missingQuestionsResult).toContain('"code": "missing_required"');
    expect(missingQuestionsResult).toContain("Required parameter 'questions' is missing or empty");
  });

  it('creates an explicit environment without relying on convenience caches', () => {
    const environment = createLLMEnvironment({
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
    const environment = createLLMEnvironment({
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

    await expect(disposeLLMEnvironment(environment)).resolves.toBeUndefined();
    await expect(disposeLLMEnvironment(environment)).resolves.toBeUndefined();
    expect(shutdownCalls).toBe(0);
  });
});
