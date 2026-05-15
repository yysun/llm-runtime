/**
 * LLM Package Provider Tool Name Helpers
 *
 * Purpose:
 * - Translate runtime tool names into provider-safe function/tool names and back.
 *
 * Key features:
 * - Sanitizes provider-facing names with a small deterministic hash suffix for long or colliding names.
 * - Preserves reverse lookup so provider tool calls execute against original runtime tool names.
 * - Supports provider-reserved names such as Anthropic server tools.
 *
 * Implementation notes:
 * - The default policy matches OpenAI-compatible function-name constraints used by the existing adapter.
 * - Translation is intentionally internal to provider adapters; runtime tool registries keep original names.
 *
 * Recent changes:
 * - 2026-05-15: Extracted shared provider-facing tool-name translation for all function-calling adapters.
 */

import type { LLMToolDefinition } from './types.js';

const DEFAULT_PROVIDER_TOOL_NAME_MAX_LENGTH = 64;
const DEFAULT_INVALID_PROVIDER_TOOL_NAME_CHARACTER_PATTERN = /[^A-Za-z0-9_-]+/g;

export type ProviderToolNameTranslator = {
  toProviderName: (runtimeName: string) => string;
  toRuntimeName: (providerName: string) => string;
};

export interface ProviderToolNameTranslatorOptions {
  maxLength?: number;
  invalidCharacterPattern?: RegExp;
  fallbackName?: string;
  reservedProviderNames?: string[];
}

function fnv1a32(input: string, reverse = false): number {
  let hash = 2166136261;
  if (reverse) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  } else {
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function createProviderToolNameHash(input: string): string {
  return `${fnv1a32(input).toString(36)}${fnv1a32(input, true).toString(36)}`.slice(0, 10);
}

function sanitizeProviderToolName(name: string, options: Required<Omit<ProviderToolNameTranslatorOptions, 'reservedProviderNames'>>): string {
  const normalized = String(name || '')
    .replace(options.invalidCharacterPattern, '_')
    .replace(/^_+|_+$/g, '') || options.fallbackName;

  if (normalized.length <= options.maxLength) {
    return normalized;
  }

  const hash = createProviderToolNameHash(name);
  const prefixLength = Math.max(1, options.maxLength - hash.length - 1);
  return `${normalized.slice(0, prefixLength)}_${hash}`;
}

function withProviderToolNameHash(
  baseName: string,
  originalName: string,
  options: Required<Omit<ProviderToolNameTranslatorOptions, 'reservedProviderNames'>>,
): string {
  const hash = createProviderToolNameHash(originalName);
  const normalizedBaseName = sanitizeProviderToolName(baseName, options);
  const prefixLength = Math.max(1, options.maxLength - hash.length - 1);
  return `${normalizedBaseName.slice(0, prefixLength)}_${hash}`;
}

export function createProviderToolNameTranslator(
  tools: Record<string, LLMToolDefinition> | undefined,
  rawOptions: ProviderToolNameTranslatorOptions = {},
): ProviderToolNameTranslator {
  const options: Required<Omit<ProviderToolNameTranslatorOptions, 'reservedProviderNames'>> = {
    maxLength: rawOptions.maxLength ?? DEFAULT_PROVIDER_TOOL_NAME_MAX_LENGTH,
    invalidCharacterPattern: rawOptions.invalidCharacterPattern ?? DEFAULT_INVALID_PROVIDER_TOOL_NAME_CHARACTER_PATTERN,
    fallbackName: rawOptions.fallbackName ?? 'tool',
  };
  const runtimeToProvider = new Map<string, string>();
  const providerToRuntime = new Map<string, string>();

  for (const reservedName of rawOptions.reservedProviderNames ?? []) {
    providerToRuntime.set(String(reservedName || '').trim(), String(reservedName || '').trim());
  }

  const reserve = (runtimeName: string): string => {
    const trimmedName = String(runtimeName || '').trim();
    if (!trimmedName) {
      return sanitizeProviderToolName(options.fallbackName, options);
    }

    const existing = runtimeToProvider.get(trimmedName);
    if (existing) {
      return existing;
    }

    let providerName = sanitizeProviderToolName(trimmedName, options);
    let collisionTarget = providerToRuntime.get(providerName);
    if (collisionTarget && collisionTarget !== trimmedName) {
      providerName = withProviderToolNameHash(providerName, trimmedName, options);
      collisionTarget = providerToRuntime.get(providerName);
    }

    let collisionSuffix = 1;
    while (collisionTarget && collisionTarget !== trimmedName) {
      providerName = withProviderToolNameHash(`${providerName}_${collisionSuffix}`, trimmedName, options);
      collisionTarget = providerToRuntime.get(providerName);
      collisionSuffix += 1;
    }

    runtimeToProvider.set(trimmedName, providerName);
    providerToRuntime.set(providerName, trimmedName);
    return providerName;
  };

  for (const [name, tool] of Object.entries(tools ?? {})) {
    reserve(name);
    if (tool?.name && tool.name !== name) {
      reserve(tool.name);
    }
  }

  return {
    toProviderName: reserve,
    toRuntimeName: (providerName) => providerToRuntime.get(String(providerName || '').trim()) ?? providerName,
  };
}