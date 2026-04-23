/**
 * LLM Package Google Provider Module
 *
 * Purpose:
 * - Provide package-owned Google Generative AI client and request helpers.
 *
 * Key features:
 * - Converts package-native messages and tool schemas into Gemini request payloads.
 * - Supports streaming and non-streaming generation with package-native `LLMResponse` output.
 * - Applies Gemini-safe schema normalization for tool declarations.
 *
 * Implementation notes:
 * - Historical tool-call replay is flattened into plain text context for Gemini compatibility.
 * - Reasoning effort maps to Gemini `thinkingConfig` budgets when explicitly provided.
 *
 * Recent changes:
 * - 2026-03-27: Initial package-owned Google provider implementation.
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import type {
  GoogleConfig,
  LLMChatMessage,
  LLMResponse,
  LLMStreamChunk,
  LLMToolDefinition,
  LLMWarning,
  LLMWebSearchOptions,
  ReasoningEffort,
} from './types.js';
import { createPackageLogger, generateId } from './provider-utils.js';

const logger = createPackageLogger();
type GoogleReasoningEffort = 'none' | 'low' | 'medium' | 'high';

const GOOGLE_SCHEMA_ALLOWED_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'propertyOrdering',
  'items',
]);

export type GoogleProviderRequest = {
  client: GoogleGenerativeAI;
  model: string;
  messages: LLMChatMessage[];
  tools?: Record<string, LLMToolDefinition>;
  temperature?: number;
  maxTokens?: number;
  webSearch?: LLMWebSearchOptions;
  reasoningEffort?: ReasoningEffort;
  abortSignal?: AbortSignal;
};

export type GoogleProviderStreamRequest = GoogleProviderRequest & {
  onChunk: (chunk: LLMStreamChunk) => void;
};

function normalizeReasoningEffort(value: ReasoningEffort | undefined): 'default' | GoogleReasoningEffort {
  if (value === 'none' || value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'default';
}

function buildGoogleThinkingConfig(reasoningEffort: ReasoningEffort | undefined): { includeThoughts: true; thinkingBudget: number } | undefined {
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (effort === 'default') {
    return undefined;
  }

  const budgets: Record<GoogleReasoningEffort, number> = {
    none: 0,
    low: 256,
    medium: 1024,
    high: 2048,
  };

  return {
    includeThoughts: true,
    thinkingBudget: budgets[effort],
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('abort') || normalized.includes('canceled') || normalized.includes('cancelled');
}

function resolveLocalSchemaRef(rootSchema: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    return undefined;
  }

  const path = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = rootSchema;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function normalizeGoogleSchemaType(
  value: unknown,
): { type?: string; nullable?: boolean } {
  if (typeof value === 'string') {
    return { type: value };
  }

  if (!Array.isArray(value)) {
    return {};
  }

  const types = value.filter((entry): entry is string => typeof entry === 'string');
  const nonNullTypes = types.filter((entry) => entry !== 'null');
  if (nonNullTypes.length === 1) {
    return {
      type: nonNullTypes[0],
      ...(types.includes('null') ? { nullable: true } : {}),
    };
  }

  return {
    type: nonNullTypes[0] ?? 'string',
    ...(types.includes('null') ? { nullable: true } : {}),
  };
}

function buildGoogleSchemaFallback(candidate: Record<string, unknown>, rootSchema: unknown, seenRefs: Set<string>): Record<string, unknown> {
  const description = typeof candidate.description === 'string' && candidate.description.trim()
    ? candidate.description
    : undefined;

  if (candidate.properties && typeof candidate.properties === 'object' && !Array.isArray(candidate.properties)) {
    const normalizedProperties = Object.fromEntries(
      Object.entries(candidate.properties as Record<string, unknown>).map(([key, value]) => [
        key,
        stripUnsupportedGoogleSchemaFields(value, rootSchema, seenRefs),
      ]),
    );

    return {
      type: 'object',
      ...(description ? { description } : {}),
      properties: normalizedProperties,
      ...(Array.isArray(candidate.required) ? { required: [...candidate.required] } : {}),
    };
  }

  if (candidate.items !== undefined) {
    return {
      type: 'array',
      ...(description ? { description } : {}),
      items: stripUnsupportedGoogleSchemaFields(candidate.items, rootSchema, seenRefs),
    };
  }

  if (Array.isArray(candidate.enum)) {
    return {
      type: typeof candidate.enum[0] === 'number' ? 'number' : 'string',
      ...(description ? { description } : {}),
      enum: candidate.enum,
    };
  }

  return {
    type: 'string',
    ...(description ? { description } : {}),
  };
}

function stripUnsupportedGoogleSchemaFields(schema: unknown, rootSchema: unknown = schema, seenRefs = new Set<string>()): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => stripUnsupportedGoogleSchemaFields(item, rootSchema, seenRefs));
  }

  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const candidate = schema as Record<string, unknown>;
  const ref = typeof candidate.$ref === 'string' ? candidate.$ref : undefined;
  if (ref) {
    if (seenRefs.has(ref)) {
      return { type: 'string' };
    }

    const resolved = resolveLocalSchemaRef(rootSchema, ref);
    const merged = resolved && typeof resolved === 'object' && !Array.isArray(resolved)
      ? {
        ...(resolved as Record<string, unknown>),
        ...Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== '$ref')),
      }
      : Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== '$ref'));

    return stripUnsupportedGoogleSchemaFields(
      Object.keys(merged).length > 0 ? merged : { type: 'string' },
      rootSchema,
      new Set([...seenRefs, ref]),
    );
  }

  const normalizedType = normalizeGoogleSchemaType(candidate.type);
  const normalizedEntries = Object.entries(candidate)
    .filter(([key]) => GOOGLE_SCHEMA_ALLOWED_KEYS.has(key))
    .map(([key, value]) => {
      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([propertyName, propertySchema]) => [
              propertyName,
              stripUnsupportedGoogleSchemaFields(propertySchema, rootSchema, seenRefs),
            ]),
          ),
        ];
      }

      if (key === 'items') {
        return [key, stripUnsupportedGoogleSchemaFields(value, rootSchema, seenRefs)];
      }

      return [key, value];
    });

  const normalized = Object.fromEntries(normalizedEntries);
  if (normalizedType.type) {
    normalized.type = normalizedType.type;
  }
  if (normalizedType.nullable === true) {
    normalized.nullable = true;
  }

  if (!normalized.type) {
    if (normalized.properties && typeof normalized.properties === 'object' && !Array.isArray(normalized.properties)) {
      normalized.type = 'object';
    } else if (normalized.items !== undefined) {
      normalized.type = 'array';
    }
  }

  if (Object.keys(normalized).length === 0) {
    return buildGoogleSchemaFallback(candidate, rootSchema, seenRefs);
  }

  return normalized;
}

export function createGoogleClient(config: GoogleConfig): GoogleGenerativeAI {
  return new GoogleGenerativeAI(config.apiKey);
}

function normalizeGoogleStructuredTool(tool: any): any {
  if (!tool || typeof tool !== 'object') {
    return tool;
  }

  if ('googleSearchRetrieval' in tool && !('googleSearch' in tool)) {
    const { googleSearchRetrieval, ...rest } = tool as Record<string, unknown>;
    return {
      ...rest,
      googleSearch: googleSearchRetrieval ?? {},
    };
  }

  return tool;
}

function stripGoogleSearchFromStructuredTools(tools: any[]): any[] {
  const hasFunctionDeclarations = tools.some((tool) =>
    tool
    && typeof tool === 'object'
    && 'functionDeclarations' in tool,
  );

  if (!hasFunctionDeclarations) {
    return tools;
  }

  let strippedGoogleSearch = false;
  const normalizedTools = tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object' || !('googleSearch' in tool)) {
      return [tool];
    }

    strippedGoogleSearch = true;
    const { googleSearch, ...rest } = tool as Record<string, unknown>;
    return Object.keys(rest).length > 0 ? [rest] : [];
  });

  if (strippedGoogleSearch) {
    logger.warn('Gemini googleSearch removed from createGoogleModel tools because Gemini does not allow Google Search with function calling in the same request');
  }

  return normalizedTools;
}

function normalizeGoogleModelTools(tools: any[] | undefined): any[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const hasStructuredToolShape = tools.some((tool) =>
    tool
    && typeof tool === 'object'
    && ('functionDeclarations' in tool || 'googleSearch' in tool || 'googleSearchRetrieval' in tool || 'codeExecution' in tool),
  );

  return hasStructuredToolShape
    ? stripGoogleSearchFromStructuredTools(tools.map((tool) => normalizeGoogleStructuredTool(tool)))
    : [{ functionDeclarations: tools }];
}

export function createGoogleModel(client: GoogleGenerativeAI, modelName: string, tools?: any[]): GenerativeModel {
  const googleTools = normalizeGoogleModelTools(tools);

  return client.getGenerativeModel({
    model: modelName,
    ...(googleTools ? { tools: googleTools } : {}),
  });
}

function convertMessagesToGoogle(messages: LLMChatMessage[]): { messages: any[]; systemInstruction: string } {
  const googleMessages: any[] = [];
  let systemInstruction = '';

  for (const message of messages) {
    if (message.role === 'system') {
      systemInstruction = message.content || '';
      continue;
    }

    if (message.role === 'tool') {
      if (!message.content?.trim()) {
        continue;
      }
      googleMessages.push({
        role: 'user',
        parts: [{ text: `[Tool result]\n${message.content}` }],
      });
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls) {
      const parts: any[] = [];

      if (message.content) {
        parts.push({ text: message.content });
      }

      if (parts.length === 0) {
        parts.push({ text: '[Tool call history omitted for Google replay compatibility]' });
      }

      googleMessages.push({
        role: 'model',
        parts,
      });
      continue;
    }

    googleMessages.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content || '' }],
    });
  }

  return { messages: googleMessages, systemInstruction };
}

function convertToolsToGoogle(tools: Record<string, LLMToolDefinition>): any[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description || '',
    parameters: stripUnsupportedGoogleSchemaFields(tool.parameters || { type: 'object', properties: {} }),
  }));
}

function buildGoogleTools(
  tools: Record<string, LLMToolDefinition> | undefined,
  webSearch: LLMWebSearchOptions | undefined,
): { googleTools?: any[]; warnings: LLMWarning[] } {
  const googleTools: any[] = [];
  const functionTools = tools && Object.keys(tools).length > 0 ? tools : undefined;
  const warnings: LLMWarning[] = [];

  if (functionTools) {
    googleTools.push({ functionDeclarations: convertToolsToGoogle(functionTools) });
  }

  if (webSearch && !functionTools) {
    googleTools.push({ googleSearch: {} });
  } else if (webSearch && functionTools) {
    logger.warn('Gemini webSearch ignored because Gemini does not allow googleSearch with function calling in the same request');
    warnings.push({
      code: 'web_search_ignored',
      provider: 'google',
      message: 'webSearch was ignored for provider google because Gemini does not allow Google Search and function calling in the same request.',
      details: {
        reason: 'google_builtin_search_conflicts_with_function_calling',
      },
    });
  }

  return {
    googleTools: googleTools.length > 0 ? googleTools : undefined,
    warnings,
  };
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

export async function streamGoogleResponse(request: GoogleProviderStreamRequest): Promise<LLMResponse> {
  const resolvedGoogleTools = buildGoogleTools(request.tools, request.webSearch);
  const converted = convertMessagesToGoogle(request.messages);
  const thinkingConfig = buildGoogleThinkingConfig(request.reasoningEffort);
  const warningChunkEmitter = createWarningChunkEmitter(request.onChunk, resolvedGoogleTools.warnings);
  const generativeModel = request.client.getGenerativeModel({
    model: request.model,
    systemInstruction: converted.systemInstruction || undefined,
    ...(resolvedGoogleTools.googleTools ? { tools: resolvedGoogleTools.googleTools } : {}),
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    } as any,
  });

  let fullResponse = '';
  const functionCalls: any[] = [];

  try {
    if (request.abortSignal?.aborted) {
      throw new DOMException('Google stream aborted before start', 'AbortError');
    }

    const result = await generativeModel.generateContentStream(
      { contents: converted.messages },
      request.abortSignal ? { signal: request.abortSignal } : undefined,
    );

    for await (const chunk of result.stream) {
      if (request.abortSignal?.aborted) {
        throw new DOMException('Google stream aborted', 'AbortError');
      }

      const parts = Array.isArray(chunk.candidates?.[0]?.content?.parts)
        ? chunk.candidates[0].content.parts
        : [];

      if (parts.length > 0) {
        for (const part of parts) {
          if (typeof part?.text === 'string' && part.text.length > 0) {
            if ((part as { thought?: boolean }).thought === true) {
              warningChunkEmitter.onChunk({ reasoningContent: part.text });
            } else {
              fullResponse += part.text;
              warningChunkEmitter.onChunk({ content: part.text });
            }
          }

          if (part.functionCall) {
            functionCalls.push({
              id: generateId(),
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {}),
              },
            });
          }
        }
      } else {
        const chunkText = chunk.text();
        if (chunkText) {
          fullResponse += chunkText;
          warningChunkEmitter.onChunk({ content: chunkText });
        }
      }
    }

    warningChunkEmitter.emitRemaining();

    if (functionCalls.length > 0) {
      const validCalls = functionCalls.filter(
        (functionCall) => functionCall.function?.name && functionCall.function.name.trim() !== '',
      );

      return appendWarnings({
        type: 'tool_calls',
        content: fullResponse,
        tool_calls: validCalls,
        assistantMessage: {
          role: 'assistant',
          content: fullResponse || '',
          tool_calls: validCalls,
        },
      }, resolvedGoogleTools.warnings);
    }

    return appendWarnings({
      type: 'text',
      content: fullResponse,
      assistantMessage: {
        role: 'assistant',
        content: fullResponse,
      },
    }, resolvedGoogleTools.warnings);
  } catch (error) {
    if (request.abortSignal?.aborted || isAbortLikeError(error)) {
      logger.info('Google streaming canceled', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    logger.error('Google streaming error', error);
    throw error;
  }
}

export async function generateGoogleResponse(request: GoogleProviderRequest): Promise<LLMResponse> {
  const resolvedGoogleTools = buildGoogleTools(request.tools, request.webSearch);
  const converted = convertMessagesToGoogle(request.messages);
  const thinkingConfig = buildGoogleThinkingConfig(request.reasoningEffort);
  const generativeModel = request.client.getGenerativeModel({
    model: request.model,
    systemInstruction: converted.systemInstruction || undefined,
    ...(resolvedGoogleTools.googleTools ? { tools: resolvedGoogleTools.googleTools } : {}),
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    } as any,
  });

  if (request.abortSignal?.aborted) {
    throw new DOMException('Google generation aborted before start', 'AbortError');
  }

  const result = await generativeModel.generateContent(
    { contents: converted.messages },
    request.abortSignal ? { signal: request.abortSignal } : undefined,
  );
  const response = result.response;
  const content = response.text() || '';
  const functionCalls: any[] = [];

  if (response.candidates?.[0]?.content?.parts) {
    for (const part of response.candidates[0].content.parts) {
      if (part.functionCall) {
        functionCalls.push({
          id: generateId(),
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }
  }

  if (functionCalls.length > 0) {
    const validCalls = functionCalls.filter(
      (functionCall) => functionCall.function?.name && functionCall.function.name.trim() !== '',
    );

    return appendWarnings({
      type: 'tool_calls',
      content,
      tool_calls: validCalls,
      assistantMessage: {
        role: 'assistant',
        content,
        tool_calls: validCalls,
      },
    }, resolvedGoogleTools.warnings);
  }

  return appendWarnings({
    type: 'text',
    content,
    assistantMessage: {
      role: 'assistant',
      content,
    },
  }, resolvedGoogleTools.warnings);
}
