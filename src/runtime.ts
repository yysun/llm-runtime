/**
 * LLM Package Runtime API
 *
 * Purpose:
 * - Expose per-call provider helpers plus a runtime facade backed by the hardened completion loop.
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
 * - 2026-05-28: Mapped repeated-tool guard stops to failed runtime results instead of completed diagnostic output.
 * - 2026-05-28: Kept host mutating-tool completion requirements independent from package built-in results.
 * - 2026-05-28: Defaulted omitted `builtIns` to all package-owned built-ins for host convenience.
 * - 2026-05-27: Previously removed implicit built-ins from runtime completion.
 * - 2026-05-27: Removed runtime-facade `agentControlMode` / `terminationMode` options; control-tool termination is the only supported behavior. Free-text responses (e.g. "I will ...", "Proceeding ...") never terminate the loop.
 * - 2026-05-27: Added true text-delta streaming and opt-in control-tool termination for runtime completion.
 * - 2026-05-27: Honored per-call skill roots even when executing through a bound runtime environment.
 * - 2026-05-27: Defaulted runtime completion to one empty-text retry so provider empty stops after tool results can recover.
 * - 2026-05-15: Rewired the runtime-facade `complete(...)` and `streamComplete(...)` methods to the hardened completion loop while preserving the existing runtime result and event contracts.
 * - 2026-05-15: Tightened the default HITL hint to prefer safe read-only lookup before asking the user to disambiguate.
 * - 2026-05-15: Added opt-in recoverable tool-execution artifacts for agent-loop use.
 * - 2026-05-15: Previously changed default built-in exposure to read-only and added package-owned tool execution helpers.
 * - 2026-05-15: Added `createRuntime(...)` as the preferred runtime facade and `disposeRuntimeCaches()` as the preferred cache cleanup API.
 * - 2026-03-28: Added explicit environment injection and removed runtime-constructor dependency from the public API.
 */

import * as path from 'path';
import {
  HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES,
  assertNoBuiltInToolNameCollisions,
  createBuiltInToolDefinitions,
} from './builtins.js';
import {
  complete as runCompletionLoopComplete,
  DEFAULT_TURN_LOOP_MAX_ITERATIONS,
  type RunCompletionLoopResult,
} from './completion-loop.js';
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
  LLMRuntimeCompleteResult,
  LLMRuntimeStreamCompleteEvent,
  LLMRuntimeStreamCompleteOptions,
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

type RuntimeCompletionState = {
  messages: LLMChatMessage[];
  output?: string | null;
  toolCalls?: LLMToolCall[];
  error?: string;
  raw?: unknown;
};

function hasHostExecutableTool(
  request: Pick<LLMRuntimeCompleteOptions, 'extraTools' | 'tools' | 'onToolCall'>,
  toolName: string,
): boolean {
  if (typeof request.onToolCall === 'function') {
    return true;
  }
  const extraTool = request.extraTools?.find((tool) => String(tool.name || '').trim() === toolName);
  const directTool = request.tools?.[toolName];
  return typeof extraTool?.execute === 'function' || typeof directTool?.execute === 'function';
}

function appendTransientInstruction(
  messages: LLMChatMessage[],
  transientInstruction?: string,
): LLMChatMessage[] {
  if (!transientInstruction) {
    return messages;
  }

  return [...messages, { role: 'system', content: transientInstruction }];
}

function normalizeToolResultContent(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (result === undefined) {
    return 'null';
  }

  try {
    return JSON.stringify(result) ?? 'null';
  } catch {
    return JSON.stringify({ error: String(result) });
  }
}

function createToolResultMessage(toolCall: LLMToolCall, result: unknown): LLMChatMessage {
  return {
    role: 'tool',
    tool_call_id: toolCall.id,
    content: normalizeToolResultContent(result),
  };
}

function isToolExecutionFailureArtifact(value: unknown): value is LLMToolExecutionFailureArtifact {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { errorType?: unknown }).errorType === 'tool_execution_failed'
    && typeof (value as { message?: unknown }).message === 'string',
  );
}

function isMutatingEvidenceKind(evidenceKind: LLMToolDefinition['evidenceKind']): boolean {
  return evidenceKind === 'write'
    || evidenceKind === 'external_action'
    || evidenceKind === 'artifact';
}

function createRequestToolDefinitionMap(
  request: Pick<LLMRuntimeCompleteOptions, 'extraTools' | 'tools'>,
): ReadonlyMap<string, LLMToolDefinition> {
  const definitions = new Map<string, LLMToolDefinition>();

  for (const tool of request.extraTools ?? []) {
    definitions.set(tool.name, tool);
  }

  for (const [toolName, tool] of Object.entries(request.tools ?? {})) {
    definitions.set(toolName, tool);
  }

  return definitions;
}

function isHostMutatingToolName(
  toolName: string,
  requestToolDefinitions: ReadonlyMap<string, LLMToolDefinition>,
): boolean {
  const definition = requestToolDefinitions.get(toolName);
  if (!definition) {
    return false;
  }

  return isMutatingEvidenceKind(definition.evidenceKind);
}

function requestExposesMutatingTools(request: LLMRuntimeCompleteOptions): boolean {
  // Built-ins default to all tools, so their availability is not evidence that the task
  // requires a write or external action. Only host tools can declare that requirement.
  for (const tool of request.extraTools ?? []) {
    if (isMutatingEvidenceKind(tool.evidenceKind)) {
      return true;
    }
  }

  for (const tool of Object.values(request.tools ?? {})) {
    if (isMutatingEvidenceKind(tool.evidenceKind)) {
      return true;
    }
  }

  return false;
}

function hasMutatingToolResult(
  messages: LLMChatMessage[],
  requestToolDefinitions: ReadonlyMap<string, LLMToolDefinition>,
): boolean {
  const toolCallNamesById = new Map<string, string>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.tool_calls ?? []) {
        toolCallNamesById.set(toolCall.id, toolCall.function.name);
      }
      continue;
    }

    if (message.role !== 'tool' || !message.tool_call_id) {
      continue;
    }

    const toolName = toolCallNamesById.get(message.tool_call_id);
    if (toolName && isHostMutatingToolName(toolName, requestToolDefinitions)) {
      return true;
    }
  }

  return false;
}

function buildRuntimeCompletionModelRequest(
  environment: LLMEnvironment,
  request: LLMRuntimeCompleteOptions,
  options: {
    streamModel?: boolean;
    onChunk?: (chunk: LLMStreamChunk) => void;
  } = {},
) {
  return {
    ...(options.streamModel ? { mode: 'stream' as const } : {}),
    provider: request.provider,
    model: request.model,
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
    context: request.context,
    ...(options.onChunk ? { onChunk: options.onChunk } : {}),
  };
}

function createRuntimeFailureMessage(reason: string): string {
  switch (reason) {
    case 'rejected_text_response':
      return 'Assistant response did not complete the task with required tool evidence.';
    case 'empty_text_stop':
      return 'Assistant returned neither tool calls nor non-empty text.';
    case 'tool_calls_response':
      return 'Completion loop stopped after handling tool calls.';
    case 'unhandled_response':
      return 'Assistant returned an unhandled response.';
    case 'repeated_tool_call_stopped':
      return 'Completion loop stopped after repeating the same tool calls.';
    default:
      return 'Completion loop failed before producing a final answer.';
  }
}

function createRepeatedToolCallDiagnosticOutput(result: {
  stop: {
    repeatedToolCall?: {
      consecutiveSameBatchCount: number;
      maxConsecutiveSameBatches: number;
      toolNames: string[];
    };
  };
}): string {
  const repeated = result.stop.repeatedToolCall;
  const toolList = repeated?.toolNames.length
    ? Array.from(new Set(repeated.toolNames)).join(', ')
    : 'unknown tool';
  const repeatCount = repeated
    ? `${repeated.consecutiveSameBatchCount} consecutive identical tool-call batches`
    : 'repeated identical tool-call batches';
  const limit = repeated
    ? `limit ${repeated.maxConsecutiveSameBatches}`
    : 'the configured limit';

  return `I could not complete the request because the model kept repeating the same tool call instead of using the previous tool result. Repeated tool: ${toolList}. Stopped after ${repeatCount}; ${limit}.`;
}

function adaptRuntimeCompleteResult(result: RunCompletionLoopResult<RuntimeCompletionState>): LLMRuntimeCompleteResult {
  if (result.reason === 'tool_calls_response' && result.state.toolCalls?.length) {
    return {
      status: 'tool_calls',
      messages: result.state.messages,
      toolCalls: result.state.toolCalls,
      raw: result.state.raw ?? result.response ?? undefined,
    };
  }

  if (result.reason === 'text_response' && result.state.output !== undefined) {
    return {
      status: 'completed',
      messages: result.state.messages,
      output: result.state.output,
      raw: result.state.raw ?? result.response ?? undefined,
    };
  }

  if (result.reason === 'final_answer' && result.controlOutput?.kind === 'final_answer') {
    return {
      status: 'completed',
      messages: result.state.messages,
      output: result.controlOutput.answer,
      raw: result.state.raw ?? result.response ?? undefined,
    };
  }

  if (result.reason === 'needs_user_input' && result.controlOutput?.kind === 'need_user_input') {
    const toolCall = result.response?.tool_calls?.find((candidate) => candidate.id === result.controlOutput?.toolCallId);
    return {
      status: 'tool_calls',
      messages: result.state.messages,
      toolCalls: toolCall ? [toolCall] : (result.response?.tool_calls ?? []),
      raw: result.state.raw ?? result.response ?? undefined,
    };
  }

  if (result.reason === 'blocked' && result.controlOutput?.kind === 'blocked') {
    return {
      status: 'failed',
      messages: result.state.messages,
      error: result.controlOutput.reason,
      raw: result.state.raw ?? result.response ?? undefined,
    };
  }

  if (result.reason === 'max_iterations_exceeded') {
    return {
      status: 'max_iterations',
      messages: result.state.messages,
      error: result.state.error ?? `Reached maxIterations=${result.stop.maxIterations} before completion.`,
      raw: result.state.raw ?? result.response ?? undefined,
    };
  }

  if (result.reason === 'repeated_tool_call_stopped') {
    const output = createRepeatedToolCallDiagnosticOutput(result);
    return {
      status: 'failed',
      messages: [
        ...result.state.messages,
        {
          role: 'assistant',
          content: output,
        },
      ],
      output,
      error: output,
      raw: result.state.raw ?? result.response ?? undefined,
    };
  }

  return {
    status: 'failed',
    messages: result.state.messages,
    error: result.state.error ?? createRuntimeFailureMessage(result.reason),
    raw: result.state.raw ?? result.response ?? undefined,
  };
}

function createAsyncEventQueue<T>() {
  const pendingValues: T[] = [];
  const pendingResolvers: Array<(value: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(value: T) {
      if (closed) {
        return;
      }

      const resolver = pendingResolvers.shift();
      if (resolver) {
        resolver({ value, done: false });
        return;
      }

      pendingValues.push(value);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      while (pendingResolvers.length > 0) {
        pendingResolvers.shift()?.({ value: undefined as T, done: true });
      }
    },
    async *iterate(): AsyncGenerator<T> {
      while (true) {
        if (pendingValues.length > 0) {
          yield pendingValues.shift() as T;
          continue;
        }

        if (closed) {
          return;
        }

        const next = await new Promise<IteratorResult<T>>((resolve) => {
          pendingResolvers.push(resolve);
        });

        if (next.done) {
          return;
        }

        yield next.value;
      }
    },
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type StreamToolCallDeltaState = {
  id?: string;
  name?: string;
  argumentsText: string;
  emittedFinalAnswer: string;
};

function getStreamToolCallStateKey(iteration: number, index: number): string {
  return `${iteration}:${index}`;
}

function readJsonStringToken(source: string, start: number): { value: string; end: number; closed: boolean } {
  let value = '';
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];

    if (char === '"') {
      return { value, end: index + 1, closed: true };
    }

    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }

    if (index + 1 >= source.length) {
      return { value, end: index, closed: false };
    }

    const escaped = source[index + 1];
    if (escaped === 'u') {
      const sequence = source.slice(index, index + 6);
      if (!/^\\u[0-9a-fA-F]{4}$/.test(sequence)) {
        return { value, end: index, closed: false };
      }
      value += String.fromCharCode(Number.parseInt(sequence.slice(2), 16));
      index += 6;
      continue;
    }

    const simpleEscapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    const decoded = simpleEscapes[escaped];
    if (decoded === undefined) {
      return { value, end: index, closed: false };
    }

    value += decoded;
    index += 2;
  }

  return { value, end: source.length, closed: false };
}

function skipJsonWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) {
    index += 1;
  }
  return index;
}

function findJsonStringPropertyValueStart(source: string, propertyName: string): number | null {
  let index = 0;

  while (index < source.length) {
    if (source[index] !== '"') {
      index += 1;
      continue;
    }

    const token = readJsonStringToken(source, index);
    if (!token.closed) {
      return null;
    }

    const afterKey = skipJsonWhitespace(source, token.end);
    if (token.value === propertyName && source[afterKey] === ':') {
      const valueStart = skipJsonWhitespace(source, afterKey + 1);
      return source[valueStart] === '"' ? valueStart + 1 : null;
    }

    index = token.end;
  }

  return null;
}

function decodeJsonStringPrefix(source: string, start: number): string {
  let value = '';
  let index = start;

  while (index < source.length) {
    const char = source[index];

    if (char === '"') {
      return value;
    }

    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }

    if (index + 1 >= source.length) {
      return value;
    }

    const escaped = source[index + 1];
    if (escaped === 'u') {
      const sequence = source.slice(index, index + 6);
      if (!/^\\u[0-9a-fA-F]{4}$/.test(sequence)) {
        return value;
      }

      const codeUnit = Number.parseInt(sequence.slice(2), 16);
      if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
        const nextSequence = source.slice(index + 6, index + 12);
        if (!/^\\u[0-9a-fA-F]{4}$/.test(nextSequence)) {
          return value;
        }
        const lowCodeUnit = Number.parseInt(nextSequence.slice(2), 16);
        if (lowCodeUnit < 0xDC00 || lowCodeUnit > 0xDFFF) {
          return value;
        }
        value += String.fromCodePoint(
          ((codeUnit - 0xD800) * 0x400) + (lowCodeUnit - 0xDC00) + 0x10000,
        );
        index += 12;
        continue;
      }

      value += String.fromCharCode(codeUnit);
      index += 6;
      continue;
    }

    const simpleEscapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    const decoded = simpleEscapes[escaped];
    if (decoded === undefined) {
      return value;
    }

    value += decoded;
    index += 2;
  }

  return value;
}

function extractFinalAnswerPrefix(argumentsText: string): string {
  const valueStart = findJsonStringPropertyValueStart(argumentsText, 'answer');
  return valueStart === null ? '' : decodeJsonStringPrefix(argumentsText, valueStart);
}

const DEFAULT_MUTATING_TOOL_RECOVERY_INSTRUCTION = 'The last response claimed completion before the required write or external action happened. Continue now by calling the necessary tool. If the required tool is unavailable or blocked, use blocked or explain the missing capability.';

async function runRuntimeCompletion(
  environment: LLMEnvironment,
  request: LLMRuntimeCompleteOptions,
  emitEvent?: (event: LLMRuntimeStreamCompleteEvent) => Promise<void> | void,
  options: {
    streamModel?: boolean;
  } = {},
): Promise<LLMRuntimeCompleteResult> {
  let activeIteration = 0;
  const streamToolCallStates = new Map<string, StreamToolCallDeltaState>();
  const mutatingToolRequired = requestExposesMutatingTools(request);
  const requestToolDefinitions = createRequestToolDefinitionMap(request);
  const loopResult = await runCompletionLoopComplete<RuntimeCompletionState>({
    initialState: {
      messages: request.messages,
    },
    modelRequest: buildRuntimeCompletionModelRequest(environment, request, {
      streamModel: options.streamModel,
      onChunk: options.streamModel
        ? (chunk) => {
          if (chunk.reasoningContent) {
            void emitEvent?.({
              type: 'reasoning_delta',
              delta: chunk.reasoningContent,
              iteration: activeIteration,
            });
          }
          if (chunk.content) {
            void emitEvent?.({
              type: 'text_delta',
              delta: chunk.content,
              iteration: activeIteration,
            });
          }
          if (chunk.toolCallDelta?.argumentsDelta !== undefined) {
            const stateKey = getStreamToolCallStateKey(activeIteration, chunk.toolCallDelta.index);
            const state = streamToolCallStates.get(stateKey) ?? {
              argumentsText: '',
              emittedFinalAnswer: '',
            };

            state.argumentsText += chunk.toolCallDelta.argumentsDelta;
            state.id = chunk.toolCallDelta.id ?? state.id;
            state.name = chunk.toolCallDelta.name ?? state.name;
            streamToolCallStates.set(stateKey, state);

            void emitEvent?.({
              type: 'tool_call_delta',
              ...(state.id ? { toolCallId: state.id } : {}),
              ...(state.name ? { toolName: state.name } : {}),
              argumentsDelta: chunk.toolCallDelta.argumentsDelta,
              index: chunk.toolCallDelta.index,
              iteration: activeIteration,
            });

            if (state.name === 'final_answer') {
              const answerPrefix = extractFinalAnswerPrefix(state.argumentsText);
              const delta = answerPrefix.slice(state.emittedFinalAnswer.length);
              if (delta) {
                state.emittedFinalAnswer = answerPrefix;
                void emitEvent?.({
                  type: 'answer_delta',
                  delta,
                  iteration: activeIteration,
                });
              }
            }
          }
        }
        : undefined,
    }),
    maxIterations: request.maxIterations,
    emptyTextRetryLimit: request.emptyTextRetryLimit ?? DEFAULT_TURN_LOOP_MAX_ITERATIONS,
    repeatedToolCallGuard: request.repeatedToolCallGuard,
    defaultTextResponseMode: request.defaultTextResponseMode ?? 'require_tool_result',
    rejectedTextRetryLimit: request.rejectedTextRetryLimit,
    abortSignal: request.context?.abortSignal,
    buildMessages: async ({ state, transientInstruction }) => appendTransientInstruction(state.messages, transientInstruction),
    onIterationStart: async ({ iteration }) => {
      activeIteration = iteration;
      await emitEvent?.({ type: 'model_start', iteration });
    },
    onModelResponse: async ({ iteration, response }) => {
      await emitEvent?.({
        type: 'assistant_message',
        message: response.assistantMessage,
        iteration,
      });
    },
    onTextResponse: async ({ state, responseText, response }) => ({
      state: {
        ...state,
        messages: [...state.messages, response.assistantMessage],
        output: responseText,
        raw: response,
      },
    }),
    onRejectedTextResponse: async ({ state, response, responseText }) => ({
      state: {
        ...state,
        messages: [...state.messages, response.assistantMessage],
        error: `Assistant response did not complete the task with required evidence: ${responseText}`,
        raw: response,
      },
    }),
    classifyTextResponse: ({ messages }) => {
      if (mutatingToolRequired) {
        if (!hasMutatingToolResult(messages, requestToolDefinitions)) {
          return {
            classification: 'non_progressing',
            transientInstruction: DEFAULT_MUTATING_TOOL_RECOVERY_INSTRUCTION,
          };
        }
        return 'verified_final_response';
      }
    },
    onFinalAnswerToolCall: async ({ state, response, controlOutput }) => {
      if (controlOutput.kind !== 'final_answer') {
        return { state };
      }

      if (mutatingToolRequired && !hasMutatingToolResult(state.messages, requestToolDefinitions)) {
        return {
          state: {
            ...state,
            messages: [...state.messages, response.assistantMessage],
            raw: response,
          },
          next: {
            control: 'continue',
            transientInstruction: DEFAULT_MUTATING_TOOL_RECOVERY_INSTRUCTION,
          },
        };
      }

      return {
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            { role: 'assistant', content: controlOutput.answer },
          ],
          output: controlOutput.answer,
          raw: response,
        },
      };
    },
    onNeedUserInputToolCall: async ({ state, response }) => ({
      state: {
        ...state,
        messages: [...state.messages, response.assistantMessage],
        toolCalls: response.tool_calls ?? [],
        raw: response,
      },
    }),
    onBlockedToolCall: async ({ state, response, controlOutput }) => {
      if (controlOutput.kind !== 'blocked') {
        return { state };
      }

      return {
        state: {
          ...state,
          messages: [...state.messages, response.assistantMessage],
          error: controlOutput.reason,
          raw: response,
        },
      };
    },
    onToolCallsResponse: async ({ state, response, toolExecutor, iteration }) => {
      const nextMessages = [...state.messages, response.assistantMessage];
      const toolCalls = response.tool_calls ?? [];
      const hostHandledHumanInputToolCalls = toolCalls.filter((toolCall) => (
        HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES.includes(toolCall.function.name as any)
        && !hasHostExecutableTool(request, toolCall.function.name)
      ));

      if (hostHandledHumanInputToolCalls.length > 0) {
        return {
          state: {
            ...state,
            messages: nextMessages,
            toolCalls,
            raw: response,
          },
        };
      }

      if (!toolExecutor) {
        return {
          state: {
            ...state,
            messages: nextMessages,
            error: 'Tool executor unavailable for runtime completion.',
            raw: response,
          },
        };
      }

      const toolMessages = [...nextMessages];
      for (const toolCall of toolCalls) {
        const parsedArguments = parseToolCallArguments(toolCall);
        const parsedArgs = parsedArguments.ok ? parsedArguments.args : {};
        const executionContext: LLMToolExecutionContext = {
          ...(request.context ?? {}),
          messages: toolMessages.map((message) => ({ ...message })),
        };
        await emitEvent?.({
          type: 'tool_start',
          toolCall,
          args: parsedArguments.ok ? parsedArguments.args : undefined,
          iteration,
        });

        let toolResult: unknown;
        const toolName = toolCall.function.name;
        if (request.onToolApproval) {
          const approval = await request.onToolApproval({ toolCall, toolName, parsedArguments: parsedArgs });
          if (!approval.approved) {
            toolResult = createToolExecutionFailureArtifact({
              toolCall,
              code: 'execution_failed',
              message: approval.reason ?? `Tool execution rejected: ${toolName}`,
            });
          }
        }

        if (toolResult === undefined && request.onToolCall) {
          const handled = await request.onToolCall({
            toolCall,
            toolName,
            parsedArguments: parsedArgs,
            context: executionContext,
            executeDefault: () => toolExecutor.executeToolCall(toolCall, executionContext, { errorMode: 'return-artifact' }),
          });
          if (handled.handled) {
            toolResult = handled.result;
          }
        }

        if (toolResult === undefined) {
          toolResult = await toolExecutor.executeToolCall(
            toolCall,
            executionContext,
            { errorMode: 'return-artifact' },
          );
        }

        toolMessages.push(createToolResultMessage(toolCall, toolResult));

        if (isToolExecutionFailureArtifact(toolResult)) {
          await emitEvent?.({
            type: 'tool_error',
            toolCall,
            error: toolResult.message,
            iteration,
          });
          continue;
        }

        await emitEvent?.({
          type: 'tool_result',
          toolCall,
          result: toolResult,
          iteration,
        });
      }

      return {
        state: {
          ...state,
          messages: toolMessages,
          raw: response,
        },
        next: { control: 'continue' },
      };
    },
    onEmptyTextStop: async ({ state, response }) => ({
      state: {
        ...state,
        messages: [...state.messages, response.assistantMessage],
        error: 'Assistant returned neither tool calls nor non-empty text.',
        raw: response,
      },
    }),
    onUnhandledResponse: async ({ state, response }) => ({
      state: {
        ...state,
        messages: [...state.messages, response.assistantMessage],
        error: 'Assistant returned an unhandled response.',
        raw: response,
      },
    }),
  });

  const runtimeResult = adaptRuntimeCompleteResult(loopResult);

  if (runtimeResult.status === 'tool_calls') {
    await emitEvent?.({
      type: 'tool_calls',
      result: runtimeResult,
      iteration: loopResult.iterations,
    });
    return runtimeResult;
  }

  if (runtimeResult.status === 'completed') {
    await emitEvent?.({
      type: 'completed',
      result: runtimeResult,
      iteration: loopResult.iterations,
    });
    return runtimeResult;
  }

  await emitEvent?.({
    type: 'failed',
    result: runtimeResult,
    iteration: loopResult.iterations,
  });
  return runtimeResult;
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
    complete: async (request) => await runRuntimeCompletion(runtime, request),
    streamComplete: async function* (request) {
      const events = createAsyncEventQueue<LLMRuntimeStreamCompleteEvent>();
      void runRuntimeCompletion(runtime, request, async (event) => {
        events.push(event);
      }, { streamModel: true }).catch(async (error) => {
        events.push({
          type: 'failed',
          result: {
            status: 'failed',
            messages: request.messages,
            error: stringifyError(error),
          },
          iteration: 0,
        });
      }).finally(() => {
        events.close();
      });

      for await (const event of events.iterate()) {
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

function resolveEnvironmentForCall(options: LLMRuntimeCompleteOptions): { environment: LLMEnvironment; ownsEnvironment: boolean } {
  if (options.environment) {
    return { environment: options.environment, ownsEnvironment: false };
  }
  const environment = createRuntime({
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.mcpConfig !== undefined ? { mcpConfig: options.mcpConfig } : {}),
    ...(options.skillRoots ? { skillRoots: options.skillRoots } : {}),
  });
  return { environment, ownsEnvironment: true };
}

export async function complete(options: LLMRuntimeCompleteOptions): Promise<LLMRuntimeCompleteResult> {
  const { environment, ownsEnvironment } = resolveEnvironmentForCall(options);
  try {
    return await runRuntimeCompletion(environment, options);
  } finally {
    if (ownsEnvironment) {
      await disposeRuntime(environment);
    }
  }
}

export async function* streamComplete(options: LLMRuntimeStreamCompleteOptions): AsyncGenerator<LLMRuntimeStreamCompleteEvent> {
  const { environment, ownsEnvironment } = resolveEnvironmentForCall(options);
  const events = createAsyncEventQueue<LLMRuntimeStreamCompleteEvent>();
  const completion = runRuntimeCompletion(environment, options, async (event) => {
    events.push(event);
  }, { streamModel: true }).catch(async (error) => {
    events.push({
      type: 'failed',
      result: {
        status: 'failed',
        messages: options.messages,
        error: stringifyError(error),
      },
      iteration: 0,
    });
  }).finally(() => {
    events.close();
  });

  try {
    for await (const event of events.iterate()) {
      yield event;
    }
    await completion;
  } finally {
    if (ownsEnvironment) {
      await disposeRuntime(environment);
    }
  }
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
    if (request.skillRoots !== undefined) {
      return {
        ...request.environment,
        skillRegistry: getOrCreateSkillRegistry(request.skillRoots),
      };
    }

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
