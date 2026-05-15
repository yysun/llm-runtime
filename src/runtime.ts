/**
 * LLM Package Runtime API
 *
 * Purpose:
 * - Expose per-call `generate(...)`, `stream(...)`, and tool-resolution APIs for `llm-runtime`.
 *
 * Key features:
 * - Supports explicit `LLMEnvironment` injection for provider/MCP/skill dependencies.
 * - Retains a convenience per-call path backed by internal caches when no environment is supplied.
 * - Keeps one shared orchestration engine for buffered and streaming calls.
 *
 * Implementation notes:
 * - The primary public model is per-call plus optional explicit environment injection.
 * - Internal caches are used only by the convenience path and are not the only execution model.
 * - Built-in tool ownership and reserved-name validation stay inside the package.
 *
 * Recent changes:
 * - 2026-05-15: Added opt-in recoverable tool-execution artifacts for agent-loop use.
 * - 2026-05-15: Changed default built-in exposure to read-only, added package-owned tool execution helpers, and gated deprecated HITL alias exposure.
 * - 2026-05-15: Added `createRuntime(...)` as the preferred runtime facade and `disposeRuntimeCaches()` as the preferred cache cleanup API.
 * - 2026-03-28: Added explicit environment injection and removed runtime-constructor dependency from the public API.
 */

import * as path from 'path';
import {
  complete,
  type CompleteOptions,
  type RunCompletionLoopResult,
} from './completion-loop.js';
import {
  HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES,
  assertNoBuiltInToolNameCollisions,
  createBuiltInToolDefinitions,
} from './builtins.js';
import {
  createAnthropicClient,
  generateAnthropicResponse,
  streamAnthropicResponse,
} from './anthropic-direct.js';
import {
  createGoogleClient,
  generateGoogleResponse,
  streamGoogleResponse,
} from './google-direct.js';
import { createProviderConfigStore } from './llm-config.js';
import { createMCPRegistry, normalizeMCPConfig } from './mcp.js';
import {
  createClientForProvider,
  generateOpenAIResponse,
  streamOpenAIResponse,
} from './openai-direct.js';
import { createSkillRegistry } from './skills.js';
import { createToolRegistry } from './tools.js';
import type {
  BuiltInToolSelection,
  LLMChatMessage,
  LLMEnvironment,
  LLMEnvironmentOptions,
  LLMExecuteToolCallOptions,
  LLMExecuteToolCallsOptions,
  LLMToolExecutionFailureArtifact,
  LLMToolExecutionFailureCode,
  LLMGenerateOptions,
  LLMProviderName,
  LLMProviderConfigStore,
  LLMProviderConfigs,
  LLMResolveToolsOptions,
  LLMResponse,
  LLMRuntime,
  LLMStreamChunk,
  LLMStreamOptions,
  LLMToolCall,
  LLMToolDefinition,
  LLMToolExecutionContext,
  LLMWarning,
  LLMWebSearchOptions,
  MCPConfig,
  MCPRegistry,
  ReasoningEffort,
  SkillRegistry,
  ToolPermission,
} from './types.js';

const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'default';
const DEFAULT_TOOL_PERMISSION: ToolPermission = 'auto';
const WEB_SEARCH_OPTION_PROVIDERS = new Set<LLMProviderName>([
  'openai',
  'anthropic',
  'google',
]);
const WORKSPACE_GUIDANCE_BUILT_IN_TOOL_NAMES = [
  'list_files',
  'search_files',
  'read_file',
  'path_exists',
  'create_directory',
] as const;
export const DEFAULT_HUMAN_INTERVENTION_TOOL_HINT = [
  'If `ask_user_input` is available, use it for clarification, missing user input, approvals, or other human decisions. `human_intervention_request` and `ask_user_question` are the same tool.',
  'Treat phrases such as "ask the user", "request approval", or "HITL" as referring to this tool when present.',
  'Use `allowSkip` only for non-blocking prompts, not required approvals or blocking decisions.',
  'Do not invent human answers.',
].join(' ');
export const DEFAULT_WORKSPACE_TOOL_HINT = [
  'Prefer `list_files`, `search_files`, `read_file`, `path_exists`, and `create_directory` for normal workspace exploration.',
  'Use `shell_cmd` only for explicit commands, git workflows, or gaps in the structured tools.',
  'With `shell_cmd`, send one command plus `parameters`, not a pipeline string.',
  'Preferred shell patterns: `rg --files`, `rg "pattern"`, `find`, `sed -n "1,200p" path`, `head -n 200 path`, `tail -n 100 path`.',
  'Prefer `rg` over `grep`, and `head` or `sed -n` over `cat` for bounded reads.',
  'On Windows, use PowerShell-native commands only if they still fit the same single-command model.',
].join(' ');

type RuntimeDefaults = Readonly<{
  reasoningEffort: ReasoningEffort;
  toolPermission: ToolPermission;
}>;

const providerConfigStoreCache = new Map<string, LLMProviderConfigStore>();
const mcpRegistryCache = new Map<string, MCPRegistry>();
const skillRegistryCache = new Map<string, SkillRegistry>();
const runtimeOwnedEnvironmentMCPRegistries = new WeakSet<LLMEnvironment>();
const disposedEnvironments = new WeakSet<LLMEnvironment>();

async function shutdownRegistries(registries: Iterable<MCPRegistry>): Promise<void> {
  const uniqueRegistries = [...new Set(registries)];
  await Promise.all(uniqueRegistries.map(async (registry) => {
    await registry.shutdown().catch(() => undefined);
  }));
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeSkillRoots(roots?: string[]): string[] {
  return [...new Set((roots ?? []).map((root) => path.resolve(String(root || '').trim())).filter(Boolean))];
}

function createDefaults(overrides?: LLMEnvironmentOptions['defaults']): RuntimeDefaults {
  return Object.freeze({
    reasoningEffort: overrides?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    toolPermission: overrides?.toolPermission ?? DEFAULT_TOOL_PERMISSION,
  });
}

function mergeProviderConfigs(options: {
  provider?: LLMGenerateOptions['provider'] | LLMStreamOptions['provider'];
  providerConfig?: LLMGenerateOptions['providerConfig'] | LLMStreamOptions['providerConfig'];
  providers?: LLMProviderConfigs;
}): LLMProviderConfigs {
  const merged: LLMProviderConfigs = {
    ...(options.providers ?? {}),
  };

  if (options.provider && options.providerConfig) {
    merged[options.provider] = options.providerConfig as any;
  }

  return merged;
}

function getOrCreateProviderConfigStore(configs: LLMProviderConfigs): LLMProviderConfigStore {
  const cacheKey = stableStringify(configs);
  const cached = providerConfigStoreCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const store = createProviderConfigStore(configs);
  providerConfigStoreCache.set(cacheKey, store);
  return store;
}

function getOrCreateMCPRegistry(config: MCPConfig | null | undefined): MCPRegistry {
  const normalizedConfig = normalizeMCPConfig(config ?? null);
  const cacheKey = stableStringify(normalizedConfig);
  const cached = mcpRegistryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const registry = createMCPRegistry(normalizedConfig);
  mcpRegistryCache.set(cacheKey, registry);
  return registry;
}

function getOrCreateSkillRegistry(
  roots?: string[],
  fileSystem?: LLMEnvironmentOptions['skillFileSystem'],
): SkillRegistry {
  const normalizedRoots = normalizeSkillRoots(roots);
  const cacheKey = stableStringify({
    roots: normalizedRoots,
    fileSystem: fileSystem ? 'custom' : 'default',
  });
  const cached = skillRegistryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const registry = createSkillRegistry({
    roots: normalizedRoots,
    ...(fileSystem ? { fileSystem } : {}),
  });
  skillRegistryCache.set(cacheKey, registry);
  return registry;
}

export function createRuntime(options: LLMEnvironmentOptions = {}): LLMRuntime {
  const providerConfigStore = options.providerConfigStore ?? createProviderConfigStore(options.providers ?? {});
  const mcpRegistry = options.mcpRegistry ?? createMCPRegistry(options.mcpConfig ?? null);
  const skillRegistry = options.skillRegistry ?? createSkillRegistry({
    roots: normalizeSkillRoots(options.skillRoots),
    ...(options.skillFileSystem ? { fileSystem: options.skillFileSystem } : {}),
  });

  const runtimeBase: LLMEnvironment = {
    defaults: createDefaults(options.defaults),
    providerConfigStore,
    mcpRegistry,
    skillRegistry,
  };

  const runtime: LLMRuntime = {
    ...runtimeBase,
    generate: async (request) => await generate({
      ...request,
      environment: runtime,
    }),
    stream: async (request) => await stream({
      ...request,
      environment: runtime,
    }),
    complete: async <TState, TMessage extends LLMChatMessage = LLMChatMessage>(
      completionOptions: CompleteOptions<TState, TMessage>,
    ): Promise<RunCompletionLoopResult<TState>> => await complete({
      ...completionOptions,
      modelRequest: completionOptions.modelRequest
        ? {
          ...completionOptions.modelRequest,
          environment: completionOptions.modelRequest.environment ?? runtime,
        }
        : completionOptions.modelRequest,
    }),
    resolveTools: (resolveOptions = {}) => resolveTools({
      ...resolveOptions,
      environment: runtime,
    }),
    executeToolCall: async (toolCall, context, resolveOptions = {}) => await executeToolCall({
      ...resolveOptions,
      environment: runtime,
      toolCall,
      context,
    }),
    executeToolCalls: async (toolCalls, context, resolveOptions = {}) => await executeToolCalls({
      ...resolveOptions,
      environment: runtime,
      toolCalls,
      context,
    }),
    dispose: async () => await disposeRuntime(runtime),
  };

  if (!options.mcpRegistry) {
    runtimeOwnedEnvironmentMCPRegistries.add(runtime);
  }

  return runtime;
}

async function disposeRuntime(environment: LLMEnvironment): Promise<void> {
  if (!runtimeOwnedEnvironmentMCPRegistries.has(environment) || disposedEnvironments.has(environment)) {
    return;
  }

  disposedEnvironments.add(environment);
  await shutdownRegistries([environment.mcpRegistry]);
}

export async function disposeRuntimeCaches(): Promise<void> {
  await shutdownRegistries(mcpRegistryCache.values());
  mcpRegistryCache.clear();
  skillRegistryCache.clear();
  providerConfigStoreCache.clear();
}

/** @deprecated Use createRuntime */
export const createLLMEnvironment = createRuntime;

/** @deprecated Use runtime.dispose() */
export const disposeLLMEnvironment = disposeRuntime;

/** @deprecated Use disposeRuntimeCaches */
export const disposeLLMRuntimeCaches = disposeRuntimeCaches;

function buildCachedEnvironment(options: {
  provider?: LLMGenerateOptions['provider'] | LLMStreamOptions['provider'];
  providerConfig?: LLMGenerateOptions['providerConfig'] | LLMStreamOptions['providerConfig'];
  providers?: LLMProviderConfigs;
  mcpConfig?: MCPConfig | null;
  skillRoots?: string[];
  defaults?: LLMEnvironmentOptions['defaults'];
}): LLMEnvironment {
  return {
    defaults: createDefaults(options.defaults),
    providerConfigStore: getOrCreateProviderConfigStore(
      mergeProviderConfigs({
        provider: options.provider,
        providerConfig: options.providerConfig,
        providers: options.providers,
      }),
    ),
    mcpRegistry: getOrCreateMCPRegistry(options.mcpConfig ?? null),
    skillRegistry: getOrCreateSkillRegistry(options.skillRoots),
  };
}

function getEnvironmentForCall(request: {
  environment?: LLMEnvironment;
  provider?: LLMGenerateOptions['provider'] | LLMStreamOptions['provider'];
  providerConfig?: LLMGenerateOptions['providerConfig'] | LLMStreamOptions['providerConfig'];
  providers?: LLMProviderConfigs;
  mcpConfig?: MCPConfig | null;
  skillRoots?: string[];
}): LLMEnvironment {
  if (request.environment) {
    return request.environment;
  }

  return buildCachedEnvironment({
    provider: request.provider,
    providerConfig: request.providerConfig,
    providers: request.providers,
    mcpConfig: request.mcpConfig,
    skillRoots: request.skillRoots,
  });
}

function resolveReasoningEffort(environment: LLMEnvironment, request: LLMGenerateOptions | LLMStreamOptions): ReasoningEffort {
  return request.context?.reasoningEffort ?? environment.defaults.reasoningEffort;
}

function normalizeWebSearchOptions(
  value: LLMGenerateOptions['webSearch'] | LLMStreamOptions['webSearch'],
): LLMWebSearchOptions | undefined {
  if (value === false) {
    return undefined;
  }

  if (value === true) {
    return {};
  }

  if (!value) {
    return undefined;
  }

  return {
    ...(value.searchContextSize ? { searchContextSize: value.searchContextSize } : {}),
  };
}

function supportsWebSearch(provider: LLMProviderName): boolean {
  return WEB_SEARCH_OPTION_PROVIDERS.has(provider);
}

function appendWarnings(response: LLMResponse, warnings: LLMWarning[]): LLMResponse {
  if (warnings.length === 0) {
    return response;
  }

  return {
    ...response,
    warnings: [...(response.warnings ?? []), ...warnings],
  };
}

function emitWarningChunk(onChunk: (chunk: LLMStreamChunk) => void, warnings: LLMWarning[]): void {
  if (warnings.length === 0) {
    return;
  }

  onChunk({ warnings });
}

function createWarningChunkEmitter(onChunk: (chunk: LLMStreamChunk) => void, warnings: LLMWarning[]): {
  onChunk: (chunk: LLMStreamChunk) => void;
  emitRemaining: () => void;
} {
  let emitted = false;

  return {
    onChunk(chunk: LLMStreamChunk) {
      if (!emitted) {
        emitWarningChunk(onChunk, warnings);
        emitted = true;
      }

      onChunk(chunk);
    },
    emitRemaining() {
      if (emitted) {
        return;
      }

      emitWarningChunk(onChunk, warnings);
      emitted = true;
    },
  };
}

function resolveWebSearch(request: LLMGenerateOptions | LLMStreamOptions): { webSearch?: LLMWebSearchOptions; warnings: LLMWarning[] } {
  if (request.webSearch !== undefined) {
    const normalized = normalizeWebSearchOptions(request.webSearch);

    if (normalized && !supportsWebSearch(request.provider)) {
      return {
        webSearch: undefined,
        warnings: [
          {
            code: 'web_search_ignored',
            provider: request.provider,
            message: `webSearch was ignored for provider ${request.provider} on the current API path.`,
            details: {
              reason: 'provider_not_supported',
            },
          },
        ],
      };
    }

    return {
      webSearch: normalized,
      warnings: [],
    };
  }

  return {
    webSearch: undefined,
    warnings: [],
  };
}

function injectToolGuidance(
  messages: LLMChatMessage[],
  tools: Record<string, LLMToolDefinition>,
): LLMChatMessage[] {
  const guidanceParts: string[] = [];

  const hasHumanInterventionTool = HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES.some((toolName) => Boolean(tools[toolName]));
  if (hasHumanInterventionTool) {
    guidanceParts.push(DEFAULT_HUMAN_INTERVENTION_TOOL_HINT);
  }

  const hasWorkspaceGuidanceTools = WORKSPACE_GUIDANCE_BUILT_IN_TOOL_NAMES.some((toolName) => Boolean(tools[toolName]));
  if (hasWorkspaceGuidanceTools) {
    guidanceParts.push(DEFAULT_WORKSPACE_TOOL_HINT);
  }

  if (guidanceParts.length === 0) {
    return messages;
  }

  const guidanceText = guidanceParts.join('\n\n');

  const systemMessageIndex = messages.findIndex((message) => message.role === 'system');
  if (systemMessageIndex >= 0) {
    const systemMessage = messages[systemMessageIndex];
    const existingContent = String(systemMessage?.content ?? '');
    if (existingContent.includes(guidanceText)) {
      return messages;
    }

    const nextMessages = messages.slice();
    nextMessages[systemMessageIndex] = {
      ...systemMessage,
      content: existingContent.trim()
        ? `${existingContent}\n\n${guidanceText}`
        : guidanceText,
    };
    return nextMessages;
  }

  return [
    {
      role: 'system',
      content: guidanceText,
    },
    ...messages,
  ];
}

function buildResolvedToolSet(options: {
  environment: LLMEnvironment;
  builtIns?: BuiltInToolSelection;
  includeDeprecatedBuiltInAliases?: boolean;
  extraTools?: LLMToolDefinition[];
  tools?: Record<string, LLMToolDefinition>;
}): Record<string, LLMToolDefinition> {
  const extraTools = options.extraTools ?? [];
  assertNoBuiltInToolNameCollisions(extraTools);

  const builtInTools = createBuiltInToolDefinitions({
    builtIns: options.builtIns,
    includeDeprecatedBuiltInAliases: options.includeDeprecatedBuiltInAliases,
    skillRegistry: options.environment.skillRegistry,
  });

  const resolved = createToolRegistry([
    ...Object.values(builtInTools),
    ...extraTools,
  ]).resolveTools();

  if (options.tools) {
    const requestToolValues = Object.values(options.tools);
    assertNoBuiltInToolNameCollisions(requestToolValues);
    return Object.fromEntries(
      Object.entries({
        ...resolved,
        ...options.tools,
      }).sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  return Object.fromEntries(
    Object.entries(resolved).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function buildResolvedToolSetAsync(options: {
  environment: LLMEnvironment;
  builtIns?: BuiltInToolSelection;
  includeDeprecatedBuiltInAliases?: boolean;
  extraTools?: LLMToolDefinition[];
  tools?: Record<string, LLMToolDefinition>;
}): Promise<Record<string, LLMToolDefinition>> {
  const resolved = buildResolvedToolSet(options);
  const mcpTools = await options.environment.mcpRegistry.resolveTools();

  return Object.fromEntries(
    Object.entries({
      ...resolved,
      ...mcpTools,
    }).sort(([left], [right]) => left.localeCompare(right)),
  );
}

type ParsedToolCallArgumentsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; code: Extract<LLMToolExecutionFailureCode, 'invalid_arguments_json' | 'invalid_arguments_shape'>; message: string };

function parseToolCallArguments(toolCall: LLMToolCall): ParsedToolCallArgumentsResult {
  const rawArguments = String(toolCall.function.arguments || '').trim();
  if (!rawArguments) {
    return { ok: true, args: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_arguments_json',
      message: `Tool "${toolCall.function.name}" arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'invalid_arguments_shape',
      message: `Tool "${toolCall.function.name}" arguments must decode to an object.`,
    };
  }

  return { ok: true, args: parsed as Record<string, unknown> };
}

function augmentToolExecutionContext(context: LLMToolExecutionContext | undefined, toolCall: LLMToolCall): LLMToolExecutionContext {
  return {
    ...(context ?? {}),
    toolCallId: context?.toolCallId ?? toolCall.id,
  };
}

function createToolExecutionFailureArtifact(params: {
  toolCall: LLMToolCall;
  code: LLMToolExecutionFailureCode;
  message: string;
}): LLMToolExecutionFailureArtifact {
  return {
    ok: false,
    status: 'error',
    errorType: 'tool_execution_failed',
    toolCallId: params.toolCall.id,
    toolName: String(params.toolCall.function.name || '').trim(),
    code: params.code,
    message: params.message,
  };
}

function handleToolExecutionFailure(
  options: LLMExecuteToolCallOptions,
  toolCall: LLMToolCall,
  code: LLMToolExecutionFailureCode,
  message: string,
): LLMToolExecutionFailureArtifact {
  if (options.errorMode === 'return-artifact') {
    return createToolExecutionFailureArtifact({ toolCall, code, message });
  }

  throw new Error(message);
}

export async function executeToolCall(options: LLMExecuteToolCallOptions): Promise<unknown> {
  const environment = getEnvironmentForCall({
    environment: options.environment,
    mcpConfig: options.mcpConfig,
    skillRoots: options.skillRoots,
  });
  const tools = await buildResolvedToolSetAsync({
    environment,
    builtIns: options.builtIns,
    includeDeprecatedBuiltInAliases: options.includeDeprecatedBuiltInAliases ?? true,
    extraTools: options.extraTools,
    tools: options.tools,
  });
  const toolName = String(options.toolCall.function.name || '').trim();
  const definition = tools[toolName];

  if (!definition) {
    return handleToolExecutionFailure(
      options,
      options.toolCall,
      'unknown_tool',
      `Tool "${toolName}" is not available in the current runtime.`,
    );
  }

  if (typeof definition.execute !== 'function') {
    return handleToolExecutionFailure(
      options,
      options.toolCall,
      'non_executable_tool',
      `Tool "${toolName}" is not executable.`,
    );
  }

  const parsedArguments = parseToolCallArguments(options.toolCall);
  if (!parsedArguments.ok) {
    return handleToolExecutionFailure(
      options,
      options.toolCall,
      parsedArguments.code,
      parsedArguments.message,
    );
  }

  try {
    return await definition.execute(
      parsedArguments.args,
      augmentToolExecutionContext(options.context, options.toolCall),
    );
  } catch (error) {
    if (options.errorMode === 'return-artifact') {
      return createToolExecutionFailureArtifact({
        toolCall: options.toolCall,
        code: 'execution_failed',
        message: `Tool "${toolName}" execution failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    throw error;
  }
}

export async function executeToolCalls(options: LLMExecuteToolCallsOptions): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const toolCall of options.toolCalls) {
    results.push(await executeToolCall({
      ...options,
      toolCall,
    }));
  }
  return results;
}

export function resolveTools(options: LLMResolveToolsOptions = {}): Record<string, LLMToolDefinition> {
  const environment = getEnvironmentForCall({
    environment: options.environment,
    mcpConfig: options.mcpConfig,
    skillRoots: options.skillRoots,
  });

  return buildResolvedToolSet({
    environment,
    builtIns: options.builtIns,
    includeDeprecatedBuiltInAliases: options.includeDeprecatedBuiltInAliases,
    extraTools: options.extraTools,
    tools: options.tools,
  });
}

export async function resolveToolsAsync(options: LLMResolveToolsOptions = {}): Promise<Record<string, LLMToolDefinition>> {
  const environment = getEnvironmentForCall({
    environment: options.environment,
    mcpConfig: options.mcpConfig,
    skillRoots: options.skillRoots,
  });

  return await buildResolvedToolSetAsync({
    environment,
    builtIns: options.builtIns,
    includeDeprecatedBuiltInAliases: options.includeDeprecatedBuiltInAliases,
    extraTools: options.extraTools,
    tools: options.tools,
  });
}

export async function generate(request: LLMGenerateOptions): Promise<LLMResponse> {
  const environment = getEnvironmentForCall({
    environment: request.environment,
    provider: request.provider,
    providerConfig: request.providerConfig,
    providers: request.providers,
    mcpConfig: request.mcpConfig,
    skillRoots: request.skillRoots,
  });
  const tools = await buildResolvedToolSetAsync({
    environment,
    builtIns: request.builtIns,
    includeDeprecatedBuiltInAliases: request.includeDeprecatedBuiltInAliases,
    extraTools: request.extraTools,
    tools: request.tools,
  });
  const messages = injectToolGuidance(request.messages, tools);
  const reasoningEffort = resolveReasoningEffort(environment, request);
  const resolvedWebSearch = resolveWebSearch(request);

  switch (request.provider) {
    case 'openai':
    case 'azure':
    case 'openai-compatible':
    case 'xai':
    case 'ollama':
      return appendWarnings(await generateOpenAIResponse({
        client: createClientForProvider(
          request.provider,
          environment.providerConfigStore.getProviderConfig(request.provider as any) as any,
        ),
        provider: request.provider,
        model: request.model,
        messages,
        tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        webSearch: resolvedWebSearch.webSearch,
        reasoningEffort,
        abortSignal: request.context?.abortSignal,
      }), resolvedWebSearch.warnings);
    case 'anthropic':
      return appendWarnings(await generateAnthropicResponse({
        client: createAnthropicClient(environment.providerConfigStore.getProviderConfig('anthropic')),
        model: request.model,
        messages,
        tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        webSearch: resolvedWebSearch.webSearch,
        abortSignal: request.context?.abortSignal,
      }), resolvedWebSearch.warnings);
    case 'google':
      return appendWarnings(await generateGoogleResponse({
        client: createGoogleClient(environment.providerConfigStore.getProviderConfig('google')),
        model: request.model,
        messages,
        tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        webSearch: resolvedWebSearch.webSearch,
        reasoningEffort,
        abortSignal: request.context?.abortSignal,
      }), resolvedWebSearch.warnings);
    default:
      throw new Error(`Unsupported provider: ${request.provider}`);
  }
}

export async function stream(request: LLMStreamOptions): Promise<LLMResponse> {
  const environment = getEnvironmentForCall({
    environment: request.environment,
    provider: request.provider,
    providerConfig: request.providerConfig,
    providers: request.providers,
    mcpConfig: request.mcpConfig,
    skillRoots: request.skillRoots,
  });
  const tools = await buildResolvedToolSetAsync({
    environment,
    builtIns: request.builtIns,
    includeDeprecatedBuiltInAliases: request.includeDeprecatedBuiltInAliases,
    extraTools: request.extraTools,
    tools: request.tools,
  });
  const messages = injectToolGuidance(request.messages, tools);
  const reasoningEffort = resolveReasoningEffort(environment, request);
  const resolvedWebSearch = resolveWebSearch(request);
  const onChunk = request.onChunk ?? (() => undefined);
  const warningChunkEmitter = createWarningChunkEmitter(onChunk, resolvedWebSearch.warnings);
  const finalizeStream = async (run: () => Promise<LLMResponse>): Promise<LLMResponse> => {
    const response = await run();
    warningChunkEmitter.emitRemaining();
    return appendWarnings(response, resolvedWebSearch.warnings);
  };

  switch (request.provider) {
    case 'openai':
    case 'azure':
    case 'openai-compatible':
    case 'xai':
    case 'ollama': {
      const provider = request.provider;
      return await finalizeStream(async () => await streamOpenAIResponse({
        client: createClientForProvider(
          provider,
          environment.providerConfigStore.getProviderConfig(provider as any) as any,
        ),
        provider,
        model: request.model,
        messages,
        tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        webSearch: resolvedWebSearch.webSearch,
        reasoningEffort,
        abortSignal: request.context?.abortSignal,
        onChunk: warningChunkEmitter.onChunk,
      }));
    }
    case 'anthropic':
      return await finalizeStream(async () => await streamAnthropicResponse({
        client: createAnthropicClient(environment.providerConfigStore.getProviderConfig('anthropic')),
        model: request.model,
        messages,
        tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        webSearch: resolvedWebSearch.webSearch,
        abortSignal: request.context?.abortSignal,
        onChunk: warningChunkEmitter.onChunk,
      }));
    case 'google':
      return await finalizeStream(async () => await streamGoogleResponse({
        client: createGoogleClient(environment.providerConfigStore.getProviderConfig('google')),
        model: request.model,
        messages,
        tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        webSearch: resolvedWebSearch.webSearch,
        reasoningEffort,
        abortSignal: request.context?.abortSignal,
        onChunk: warningChunkEmitter.onChunk,
      }));
    default:
      throw new Error(`Unsupported provider: ${request.provider}`);
  }
}

export async function __resetLLMCallCachesForTests(): Promise<void> {
  await disposeRuntimeCaches();
}