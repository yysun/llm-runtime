/**
 * LLM Package Runtime API
 *
 * Purpose:
 * - Expose per-call provider helpers plus a runtime facade backed by `agentic-complete.ts`.
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
 * - 2026-05-15: Replaced runtime-facade `stream(...)` with agentic `complete(...)` and `streamComplete(...)` wired directly through `agentic-complete.ts` while preserving tool resolution and execution behavior.
 * - 2026-05-15: Tightened the default HITL hint to prefer safe read-only lookup before asking the user to disambiguate.
 * - 2026-05-15: Added opt-in recoverable tool-execution artifacts for agent-loop use.
 * - 2026-05-15: Changed default built-in exposure to read-only and added package-owned tool execution helpers.
 * - 2026-05-15: Added `createRuntime(...)` as the preferred runtime facade and `disposeRuntimeCaches()` as the preferred cache cleanup API.
 * - 2026-03-28: Added explicit environment injection and removed runtime-constructor dependency from the public API.
 */

import * as path from 'path';
import {
  complete as runAgenticComplete,
  streamComplete as runAgenticStreamComplete,
  type ChatMessage as AgenticChatMessage,
  type CompleteOptions as AgenticCompleteOptions,
  type ModelAdapter as AgenticModelAdapter,
  type RuntimeTool as AgenticRuntimeTool,
  type ToolCall as AgenticToolCall,
} from './agentic-complete.js';
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
import { DEFAULT_COMPLETE_BUILT_INS } from './complete-defaults.js';
import {
  containsAgentRunLoopSystemPrompt,
  upsertManagedSystemPrompt,
} from './prompt-contracts.js';
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
  LLMRuntimeCompleteOptions,
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

export {
  DEFAULT_HUMAN_INTERVENTION_TOOL_HINT,
  DEFAULT_WORKSPACE_TOOL_HINT,
} from './prompt-contracts.js';

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

function stringifyToolCallArguments(value: string | Record<string, unknown>): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value) ?? '{}';
}

function normalizeLLMToolCallToAgentic(toolCall: LLMToolCall): AgenticToolCall {
  return {
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function.name,
      arguments: stringifyToolCallArguments(toolCall.function.arguments),
    },
  };
}

function normalizeAgenticToolCallToLLM(toolCall: AgenticToolCall): LLMToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.function.name,
      arguments: stringifyToolCallArguments(toolCall.function.arguments),
    },
  };
}

function normalizeLLMMessageToAgentic(message: LLMChatMessage): AgenticChatMessage {
  return {
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls?.map(normalizeLLMToolCallToAgentic),
    tool_call_id: message.tool_call_id,
  };
}

function normalizeAgenticMessageToLLM(message: AgenticChatMessage): LLMChatMessage {
  return {
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content == null
        ? ''
        : String(message.content),
    tool_calls: message.tool_calls?.map(normalizeAgenticToolCallToLLM),
    tool_call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
  };
}

function normalizeAgenticToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { value: args };
  }

  return args as Record<string, unknown>;
}

function mergeAbortSignal(
  context: LLMToolExecutionContext | undefined,
  signal: AbortSignal | undefined,
): LLMToolExecutionContext | undefined {
  if (!context && !signal) {
    return context;
  }

  return {
    ...(context ?? {}),
    abortSignal: signal ?? context?.abortSignal,
  };
}

function getCompleteBuiltIns(selection: BuiltInToolSelection | undefined): BuiltInToolSelection | undefined {
  return selection === undefined ? DEFAULT_COMPLETE_BUILT_INS : selection;
}

function createAgenticRuntimeTool(
  definition: LLMToolDefinition,
  requestContext: LLMToolExecutionContext | undefined,
): AgenticRuntimeTool {
  const isHumanInputTool = HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES.includes(definition.name as any);

  return {
    name: definition.name,
    definition: {
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      },
    },
    kind: isHumanInputTool ? 'human_input' : undefined,
    execute: definition.execute
      ? async (args, context) => await definition.execute?.(
        normalizeAgenticToolArgs(args),
        {
          ...(mergeAbortSignal(requestContext, context.signal) ?? {}),
          messages: context.messages.map((message) => ({
            ...normalizeAgenticMessageToLLM(message),
            ...(typeof message.name === 'string' ? { name: message.name } : {}),
          })),
          toolCallId: context.toolCall.id,
        },
      )
      : undefined,
  };
}

function createAgenticModelAdapter(
  environment: LLMEnvironment,
  request: LLMRuntimeCompleteOptions,
): AgenticModelAdapter {
  return {
    call: async (input) => {
      const response = await generate({
        provider: request.provider,
        model: request.model,
        messages: input.messages.map(normalizeAgenticMessageToLLM),
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        webSearch: request.webSearch,
        providerConfig: request.providerConfig,
        providers: request.providers,
        mcpConfig: request.mcpConfig,
        skillRoots: request.skillRoots,
        builtIns: getCompleteBuiltIns(request.builtIns),
        extraTools: request.extraTools,
        tools: request.tools,
        environment,
        context: mergeAbortSignal(request.context, input.signal),
      });

      return {
        message: normalizeLLMMessageToAgentic(response.assistantMessage),
        raw: response,
      };
    },
  };
}

async function createAgenticCompleteOptions(
  environment: LLMEnvironment,
  request: LLMRuntimeCompleteOptions,
): Promise<AgenticCompleteOptions> {
  const resolvedTools = await buildResolvedToolSetAsync({
    environment,
    builtIns: getCompleteBuiltIns(request.builtIns),
    extraTools: request.extraTools,
    tools: request.tools,
  });

  return {
    model: createAgenticModelAdapter(environment, request),
    messages: upsertManagedSystemPrompt(request.messages, {
      includeAgentRunLoopContract: true,
    }).map(normalizeLLMMessageToAgentic),
    tools: Object.values(resolvedTools).map((tool) => createAgenticRuntimeTool(tool, request.context)),
    ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
    ...(request.humanInputToolName ? { humanInputToolName: request.humanInputToolName } : {}),
    signal: request.context?.abortSignal,
  };
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
    complete: async (request) => await runAgenticComplete(
      await createAgenticCompleteOptions(runtime, request),
    ),
    streamComplete: async function* (request) {
      const completeOptions = await createAgenticCompleteOptions(runtime, request);

      for await (const event of runAgenticStreamComplete(completeOptions)) {
        yield event;
      }
    },
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
  const hasHumanInterventionTool = HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES.some((toolName) => Boolean(tools[toolName]));
  const hasWorkspaceGuidanceTools = WORKSPACE_GUIDANCE_BUILT_IN_TOOL_NAMES.some((toolName) => Boolean(tools[toolName]));

  const includesAgentRunLoopContract = messages.some((message) => message.role === 'system'
    && containsAgentRunLoopSystemPrompt(String(message.content ?? '')));

  if (!includesAgentRunLoopContract && !hasHumanInterventionTool && !hasWorkspaceGuidanceTools) {
    return messages;
  }

  if (includesAgentRunLoopContract) {
    return upsertManagedSystemPrompt(messages, {
      includeAgentRunLoopContract: true,
    });
  }

  return upsertManagedSystemPrompt(messages, {
    includeAgentRunLoopContract: false,
    includeHumanInterventionHint: hasHumanInterventionTool,
    includeWorkspaceToolHint: hasWorkspaceGuidanceTools,
  });
}

function buildResolvedToolSet(options: {
  environment: LLMEnvironment;
  builtIns?: BuiltInToolSelection;
  extraTools?: LLMToolDefinition[];
  tools?: Record<string, LLMToolDefinition>;
}): Record<string, LLMToolDefinition> {
  const extraTools = options.extraTools ?? [];
  assertNoBuiltInToolNameCollisions(extraTools);

  const builtInTools = createBuiltInToolDefinitions({
    builtIns: options.builtIns,
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
