/**
 * LLM Package Types
 *
 * Purpose:
 * - Define the public type contracts for the publishable `llm-runtime` package.
 *
 * Key features:
 * - Provider configuration types decoupled from `core`.
 * - Tool, MCP, and skill registry contracts used by the package runtime.
 * - Minimal per-call execution context for package consumers.
 *
 * Implementation notes:
 * - Uses string unions instead of `core` enums to avoid package-to-core coupling.
 * - Keeps world/chat/agent identifiers out of the primary API surface.
 * - Leaves room for future provider invocation APIs without breaking current contracts.
 *
 * Recent changes:
 * - 2026-05-15: Added tool evidence metadata so completion loops can separate interaction progress from task action evidence.
 * - 2026-05-15: Added recoverable tool-execution artifacts, safer built-in selection modes, optional deprecated alias exposure, and runtime-owned tool-execution helper types.
 * - 2026-03-27: Initial package-owned public API contracts for `packages/llm`.
 * - 2026-03-27: Added runtime-scoped provider store contracts and constructor-time provider config.
 * - 2026-03-27: Added built-in tool catalog, package-owned HITL pending artifacts, and additive extra-tool contracts.
 * - 2026-03-27: Added package-native message/response/provider invocation contracts.
 * - 2026-05-14: Replaced the built-in `grep` tool name with `search_files`, `create_directory`, and `path_exists`.
 * - 2026-05-15: Added runtime-facade types and the deprecated `ask_user_question` HITL alias.
 */

import type {
  CompleteOptions,
  RunCompletionLoopResult,
} from './completion-loop.js';

export type LLMProviderName =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure'
  | 'xai'
  | 'openai-compatible'
  | 'ollama';

export type ReasoningEffort = 'default' | 'none' | 'low' | 'medium' | 'high';
export type ToolPermission = 'auto' | 'ask' | 'read';
export type WebSearchContextSize = 'low' | 'medium' | 'high';
export type HitlSelectionType = 'single-select' | 'multiple-select';
export type BuiltInToolName =
  | 'shell_cmd'
  | 'load_skill'
  /** @deprecated Use 'ask_user_input' */
  | 'human_intervention_request'
  /** @deprecated Use 'ask_user_input' */
  | 'ask_user_question'
  | 'ask_user_input'
  | 'web_fetch'
  | 'read_file'
  | 'write_file'
  | 'list_files'
  | 'search_files'
  | 'create_directory'
  | 'path_exists';

export type BuiltInToolSelectionMode = 'all' | 'read-only';

export interface BaseLLMConfig {
  apiKey?: string;
  baseUrl?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

export interface OpenAIConfig extends Required<Pick<BaseLLMConfig, 'apiKey'>> { }
export interface AnthropicConfig extends Required<Pick<BaseLLMConfig, 'apiKey'>> { }
export interface GoogleConfig extends Required<Pick<BaseLLMConfig, 'apiKey'>> { }
export interface XAIConfig extends Required<Pick<BaseLLMConfig, 'apiKey'>> { }
export interface OpenAICompatibleConfig extends Required<Pick<BaseLLMConfig, 'apiKey' | 'baseUrl'>> { }
export interface OllamaConfig extends Required<Pick<BaseLLMConfig, 'baseUrl'>> { }
export interface AzureConfig extends Required<Pick<BaseLLMConfig, 'apiKey' | 'deployment'>> {
  resourceName: string;
  apiVersion?: string;
}

export interface ProviderConfigMap {
  openai: OpenAIConfig;
  anthropic: AnthropicConfig;
  google: GoogleConfig;
  azure: AzureConfig;
  xai: XAIConfig;
  'openai-compatible': OpenAICompatibleConfig;
  ollama: OllamaConfig;
}

export type ProviderConfig = ProviderConfigMap[keyof ProviderConfigMap];
export type LLMProviderConfigs = Partial<{ [K in LLMProviderName]: ProviderConfigMap[K] }>;

export interface LLMToolCall {
  id: string;
  type: 'function';
  synthetic?: boolean;
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  createdAt?: Date;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface LLMWarning {
  code: 'web_search_ignored';
  message: string;
  provider?: LLMProviderName;
  details?: Record<string, unknown>;
}

export interface LLMResponse {
  type: 'text' | 'tool_calls';
  content: string;
  tool_calls?: LLMToolCall[];
  assistantMessage: LLMChatMessage;
  usage?: LLMUsage;
  warnings?: LLMWarning[];
}

export interface LLMStreamChunk {
  content?: string;
  reasoningContent?: string;
  warnings?: LLMWarning[];
}

export interface LLMProviderConfigStore {
  configureProvider: <T extends LLMProviderName>(provider: T, config: ProviderConfigMap[T]) => void;
  getProviderConfig: <T extends LLMProviderName>(provider: T) => ProviderConfigMap[T];
  isProviderConfigured: (provider: LLMProviderName) => boolean;
  getConfiguredProviders: () => LLMProviderName[];
  getConfigurationStatus: () => Record<LLMProviderName, boolean>;
  clearProviderConfiguration: () => void;
}

export interface MCPServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface MCPConfig {
  servers?: Record<string, MCPServerDefinition>;
  mcpServers?: Record<string, MCPServerDefinition>;
}

export interface MCPRegistryEntry extends MCPServerDefinition {
  name: string;
}

export interface SkillEntry {
  skillId: string;
  description: string;
  sourcePath: string;
  rootPath: string;
}

export interface LoadedSkill extends SkillEntry {
  content: string;
}

export interface SkillRegistrySyncResult {
  skills: SkillEntry[];
}

export interface LLMToolExecutionContext {
  workingDirectory?: string;
  reasoningEffort?: ReasoningEffort;
  toolPermission?: ToolPermission;
  abortSignal?: AbortSignal;
  sequenceId?: string;
  parentToolCallId?: string;
  toolCallId?: string;
  chatId?: string | null;
  agentName?: string | null;
  world?: unknown;
  messages?: Array<Record<string, unknown>>;
  llmResultMode?: 'minimal' | 'verbose';
  persistToolEnvelope?: boolean;
  metadata?: Record<string, unknown>;
}

export type LLMToolEvidenceKind =
  | 'none'
  | 'interaction'
  | 'read'
  | 'write'
  | 'external_action'
  | 'artifact';

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  evidenceKind?: LLMToolEvidenceKind;
  execute?: (args: Record<string, unknown>, context?: LLMToolExecutionContext) => Promise<unknown> | unknown;
}

export interface LLMToolRegistry {
  registerTool: (tool: LLMToolDefinition) => void;
  registerTools: (tools: LLMToolDefinition[]) => void;
  getTool: (name: string) => LLMToolDefinition | undefined;
  listTools: () => LLMToolDefinition[];
  resolveTools: (extraTools?: LLMToolDefinition[]) => Record<string, LLMToolDefinition>;
}

export type BuiltInToolSelection = boolean | BuiltInToolSelectionMode | Partial<Record<BuiltInToolName, boolean>>;

export interface LLMWebSearchOptions {
  searchContextSize?: WebSearchContextSize;
}

export interface HitlInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface HitlInputQuestion {
  header: string;
  id: string;
  question: string;
  options: HitlInputOption[];
}

export interface PendingHitlToolResult {
  ok: false;
  pending: true;
  status: 'pending';
  confirmed: false;
  requestId: string;
  type: HitlSelectionType;
  allowSkip: boolean;
  questions: HitlInputQuestion[];
}

export interface ToolValidationIssue {
  path: string;
  code: 'missing_required' | 'unknown_parameter' | 'invalid_type';
  message: string;
  expectedType?: string;
  receivedType?: string;
}

export interface ToolValidationFailureArtifact {
  ok: false;
  status: 'error';
  errorType: 'tool_parameter_validation_failed';
  toolName: string;
  message: string;
  issues: ToolValidationIssue[];
  corrections: string[];
}

export type LLMToolExecutionErrorMode = 'throw' | 'return-artifact';

export type LLMToolExecutionFailureCode =
  | 'invalid_arguments_json'
  | 'invalid_arguments_shape'
  | 'unknown_tool'
  | 'non_executable_tool'
  | 'execution_failed';

export interface LLMToolExecutionFailureArtifact {
  ok: false;
  status: 'error';
  errorType: 'tool_execution_failed';
  toolCallId: string;
  toolName: string;
  code: LLMToolExecutionFailureCode;
  message: string;
}

export interface LLMToolExecutionOptions {
  errorMode?: LLMToolExecutionErrorMode;
}

export interface SkillFileSystemAdapter {
  access(path: string): Promise<void>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  readdir(
    path: string,
    options: { withFileTypes: true }
  ): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean }>>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

export interface SkillRegistryOptions {
  roots?: string[];
  fileSystem?: SkillFileSystemAdapter;
}

export interface MCPRegistry {
  getConfig: () => MCPConfig | null;
  setConfig: (config: MCPConfig | null) => void;
  listServers: () => MCPRegistryEntry[];
  resolveTools: () => Promise<Record<string, LLMToolDefinition>>;
  shutdown: () => Promise<void>;
}

export interface SkillRegistry {
  getRoots: () => string[];
  setRoots: (roots: string[]) => void;
  sync: () => Promise<SkillRegistrySyncResult>;
  listSkills: () => Promise<SkillEntry[]>;
  getSkill: (skillId: string) => Promise<SkillEntry | undefined>;
  loadSkill: (skillId: string) => Promise<LoadedSkill | undefined>;
}

export interface LLMEnvironment {
  defaults: {
    reasoningEffort: ReasoningEffort;
    toolPermission: ToolPermission;
  };
  providerConfigStore: LLMProviderConfigStore;
  mcpRegistry: MCPRegistry;
  skillRegistry: SkillRegistry;
}

export interface LLMEnvironmentOptions {
  defaults?: {
    reasoningEffort?: ReasoningEffort;
    toolPermission?: ToolPermission;
  };
  providers?: LLMProviderConfigs;
  providerConfigStore?: LLMProviderConfigStore;
  mcpConfig?: MCPConfig | null;
  mcpRegistry?: MCPRegistry;
  skillRoots?: string[];
  skillRegistry?: SkillRegistry;
  skillFileSystem?: SkillFileSystemAdapter;
}

export type LLMRuntimeGenerateOptions = Omit<LLMGenerateOptions, 'environment'>;
export type LLMRuntimeStreamOptions = Omit<LLMStreamOptions, 'environment'>;
export type LLMRuntimeResolveToolsOptions = Omit<LLMResolveToolsOptions, 'environment'>;
export type LLMRuntimeExecuteToolOptions = LLMRuntimeResolveToolsOptions & LLMToolExecutionOptions;

export interface LLMRuntime extends LLMEnvironment {
  generate: (request: LLMRuntimeGenerateOptions) => Promise<LLMResponse>;
  stream: (request: LLMRuntimeStreamOptions) => Promise<LLMResponse>;
  complete: <TState, TMessage extends LLMChatMessage = LLMChatMessage>(
    options: CompleteOptions<TState, TMessage>
  ) => Promise<RunCompletionLoopResult<TState>>;
  resolveTools: (options?: LLMRuntimeResolveToolsOptions) => Record<string, LLMToolDefinition>;
  executeToolCall: (toolCall: LLMToolCall, context?: LLMToolExecutionContext, options?: LLMRuntimeExecuteToolOptions) => Promise<unknown>;
  executeToolCalls: (toolCalls: LLMToolCall[], context?: LLMToolExecutionContext, options?: LLMRuntimeExecuteToolOptions) => Promise<unknown[]>;
  dispose: () => Promise<void>;
}

export interface LLMPerCallProviderOptions {
  provider: LLMProviderName;
  model: string;
  messages: LLMChatMessage[];
  temperature?: number;
  maxTokens?: number;
  webSearch?: boolean | LLMWebSearchOptions;
  providerConfig?: ProviderConfig;
  providers?: LLMProviderConfigs;
  mcpConfig?: MCPConfig | null;
  skillRoots?: string[];
  builtIns?: BuiltInToolSelection;
  includeDeprecatedBuiltInAliases?: boolean;
  extraTools?: LLMToolDefinition[];
  tools?: Record<string, LLMToolDefinition>;
  environment?: LLMEnvironment;
  context?: LLMToolExecutionContext;
}

export interface LLMGenerateOptions extends LLMPerCallProviderOptions { }

export interface LLMStreamOptions extends LLMPerCallProviderOptions {
  onChunk?: (chunk: LLMStreamChunk) => void;
}

export interface LLMResolveToolsOptions {
  mcpConfig?: MCPConfig | null;
  skillRoots?: string[];
  builtIns?: BuiltInToolSelection;
  includeDeprecatedBuiltInAliases?: boolean;
  extraTools?: LLMToolDefinition[];
  tools?: Record<string, LLMToolDefinition>;
  environment?: LLMEnvironment;
}

export interface LLMExecuteToolCallOptions extends LLMResolveToolsOptions, LLMToolExecutionOptions {
  toolCall: LLMToolCall;
  context?: LLMToolExecutionContext;
}

export interface LLMExecuteToolCallsOptions extends LLMResolveToolsOptions, LLMToolExecutionOptions {
  toolCalls: LLMToolCall[];
  context?: LLMToolExecutionContext;
}
