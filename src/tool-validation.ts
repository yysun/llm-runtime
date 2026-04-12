/**
 * LLM Package Tool Validation
 *
 * Purpose:
 * - Provide package-owned argument validation and normalization for tool execution.
 *
 * Key features:
 * - Validates required parameters and simple JSON-schema primitive types.
 * - Normalizes common built-in alias fields before execution.
 * - Wraps tool execution so direct package consumers get the same guardrails as host integrations.
 *
 * Implementation notes:
 * - Validation is intentionally scoped to the schema patterns used by this package today.
 * - This module avoids app-specific event emission so it stays reusable.
 * - Built-in tool aliases mirror current runtime compatibility behavior where practical.
 *
 * Recent changes:
 * - 2026-03-27: Added package-owned validation for built-in tool execution.
 */

import type {
  LLMToolDefinition,
  ToolValidationFailureArtifact,
  ToolValidationIssue,
} from './types.js';

export interface ToolParameterValidationResult {
  valid: boolean;
  correctedArgs?: Record<string, unknown>;
  error?: string;
  issues?: ToolValidationIssue[];
  corrections?: string[];
}

export const DEFAULT_TOOL_VALIDATION_RECOVERY_INSTRUCTION = 'Your previous tool call failed validation. Emit a corrected tool call now with the required parameters. Do not narrate what you intend to do next.';

function normalizeKnownParameterAliases(toolName: string, args: Record<string, unknown>): {
  normalizedArgs: Record<string, unknown>;
  corrections: string[];
} {
  const normalizedArgs = { ...args };
  const corrections: string[] = [];

  if (
    toolName === 'read_file'
    && normalizedArgs.filePath === undefined
    && normalizedArgs.path !== undefined
  ) {
    normalizedArgs.filePath = normalizedArgs.path;
    delete normalizedArgs.path;
    corrections.push('path -> filePath');
  }

  if (toolName === 'list_files' && normalizedArgs.path === undefined && normalizedArgs.directory !== undefined) {
    normalizedArgs.path = normalizedArgs.directory;
    delete normalizedArgs.directory;
    corrections.push('directory -> path');
  }

  if (toolName === 'list_files' && normalizedArgs.includePattern === undefined && normalizedArgs['.includePattern'] !== undefined) {
    normalizedArgs.includePattern = normalizedArgs['.includePattern'];
    delete normalizedArgs['.includePattern'];
    corrections.push('.includePattern -> includePattern');
  }

  if (
    toolName === 'grep'
    && normalizedArgs.directoryPath === undefined
    && normalizedArgs.directory !== undefined
  ) {
    normalizedArgs.directoryPath = normalizedArgs.directory;
    delete normalizedArgs.directory;
    corrections.push('directory -> directoryPath');
  }

  if (
    toolName === 'grep'
    && normalizedArgs.directoryPath === undefined
    && normalizedArgs.path !== undefined
  ) {
    normalizedArgs.directoryPath = normalizedArgs.path;
    delete normalizedArgs.path;
    corrections.push('path -> directoryPath');
  }

  if (
    toolName === 'grep'
    && normalizedArgs.includePattern === undefined
    && normalizedArgs['.includePattern'] !== undefined
  ) {
    normalizedArgs.includePattern = normalizedArgs['.includePattern'];
    delete normalizedArgs['.includePattern'];
    corrections.push('.includePattern -> includePattern');
  }

  if (toolName === 'human_intervention_request') {
    if (normalizedArgs.question === undefined && normalizedArgs.prompt !== undefined) {
      normalizedArgs.question = normalizedArgs.prompt;
      delete normalizedArgs.prompt;
      corrections.push('prompt -> question');
    }
    if (normalizedArgs.defaultOption === undefined && normalizedArgs.default_option !== undefined) {
      normalizedArgs.defaultOption = normalizedArgs.default_option;
      delete normalizedArgs.default_option;
      corrections.push('default_option -> defaultOption');
    }
  }

  if (toolName === 'web_fetch') {
    if (normalizedArgs.url === undefined && normalizedArgs.uri !== undefined) {
      normalizedArgs.url = normalizedArgs.uri;
      delete normalizedArgs.uri;
      corrections.push('uri -> url');
    }
    if (normalizedArgs.url === undefined && normalizedArgs.href !== undefined) {
      normalizedArgs.url = normalizedArgs.href;
      delete normalizedArgs.href;
      corrections.push('href -> url');
    }
  }

  if (toolName === 'shell_cmd') {
    if (normalizedArgs.workingDirectory !== undefined) {
      delete normalizedArgs.workingDirectory;
      corrections.push('workingDirectory stripped');
    }
    if (normalizedArgs.working_directory !== undefined) {
      delete normalizedArgs.working_directory;
      corrections.push('working_directory stripped');
    }
  }

  return { normalizedArgs, corrections };
}

export function validateToolParameters(
  args: unknown,
  toolSchema: Record<string, unknown> | undefined,
  toolName: string,
): ToolParameterValidationResult {
  const schemaProperties = toolSchema?.properties;
  if (!schemaProperties || typeof schemaProperties !== 'object') {
    return {
      valid: true,
      correctedArgs: (args && typeof args === 'object') ? { ...(args as Record<string, unknown>) } : {},
      corrections: [],
    };
  }

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    const receivedType = Array.isArray(args) ? 'array' : typeof args;
    return {
      valid: false,
      error: `Tool arguments must be an object, got: ${receivedType}`,
      issues: [{
        path: '$',
        code: 'invalid_type',
        message: `Tool arguments must be an object, got: ${receivedType}`,
        expectedType: 'object',
        receivedType,
      }],
      corrections: [],
    };
  }

  const aliasNormalization = normalizeKnownParameterAliases(
    toolName,
    args as Record<string, unknown>,
  );
  const normalizedArgs = aliasNormalization.normalizedArgs;
  const correctedArgs: Record<string, unknown> = {};
  const requiredParams = Array.isArray(toolSchema.required) ? toolSchema.required : [];
  const allowsAdditionalProperties = toolSchema.additionalProperties !== false;
  const issues: ToolValidationIssue[] = [];

  for (const requiredParam of requiredParams) {
    const value = normalizedArgs[requiredParam as string];
    if (value === undefined || value === null || value === '') {
      issues.push({
        path: String(requiredParam),
        code: 'missing_required',
        message: `Required parameter '${String(requiredParam)}' is missing or empty`,
      });
    }
  }

  for (const [key, value] of Object.entries(normalizedArgs)) {
    const propSchema = (schemaProperties as Record<string, any>)[key];
    if (!propSchema) {
      if (!allowsAdditionalProperties) {
        issues.push({
          path: key,
          code: 'unknown_parameter',
          message: `Unknown parameter '${key}' is not allowed`,
        });
        continue;
      }
      correctedArgs[key] = value;
      continue;
    }

    if ((value === null || value === undefined) && !requiredParams.includes(key)) {
      continue;
    }

    if (propSchema.type === 'array' && typeof value === 'string' && value !== '') {
      correctedArgs[key] = [value];
      continue;
    }

    if (propSchema.type === 'array' && !Array.isArray(value)) {
      issues.push({
        path: key,
        code: 'invalid_type',
        message: `Parameter '${key}' must be an array, got: ${typeof value}`,
        expectedType: 'array',
        receivedType: typeof value,
      });
      continue;
    }

    if (propSchema.type === 'number' && typeof value === 'string') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        correctedArgs[key] = parsed;
        continue;
      }
    }

    if (propSchema.type === 'string' && typeof value !== 'string') {
      issues.push({
        path: key,
        code: 'invalid_type',
        message: `Parameter '${key}' must be a string, got: ${typeof value}`,
        expectedType: 'string',
        receivedType: typeof value,
      });
      continue;
    }

    if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
      issues.push({
        path: key,
        code: 'invalid_type',
        message: `Parameter '${key}' must be a boolean, got: ${typeof value}`,
        expectedType: 'boolean',
        receivedType: typeof value,
      });
      continue;
    }

    correctedArgs[key] = value;
  }

  if (issues.length > 0) {
    return {
      valid: false,
      error: issues.map((issue) => issue.message).join('; '),
      issues,
      corrections: aliasNormalization.corrections,
    };
  }

  return {
    valid: true,
    correctedArgs,
    corrections: aliasNormalization.corrections,
  };
}

export function createToolValidationFailureArtifact(params: {
  toolName: string;
  validation: ToolParameterValidationResult;
}): ToolValidationFailureArtifact {
  const message = `Tool parameter validation failed for ${params.toolName}: ${params.validation.error ?? 'Unknown validation error'}`;

  return {
    ok: false,
    status: 'error',
    errorType: 'tool_parameter_validation_failed',
    toolName: params.toolName,
    message,
    issues: params.validation.issues ?? [],
    corrections: params.validation.corrections ?? [],
  };
}

export function isToolValidationFailureArtifact(value: unknown): value is ToolValidationFailureArtifact {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { ok?: unknown }).ok === false
    && (value as { status?: unknown }).status === 'error'
    && (value as { errorType?: unknown }).errorType === 'tool_parameter_validation_failed'
    && typeof (value as { toolName?: unknown }).toolName === 'string'
    && Array.isArray((value as { issues?: unknown }).issues),
  );
}

export function parseToolValidationFailureArtifact(content: unknown): ToolValidationFailureArtifact | null {
  if (isToolValidationFailureArtifact(content)) {
    return content;
  }

  if (typeof content !== 'string' || !content.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(content);
    return isToolValidationFailureArtifact(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function formatToolValidationFailureArtifact(params: {
  toolName: string;
  validation: ToolParameterValidationResult;
}): string {
  return JSON.stringify(createToolValidationFailureArtifact(params), null, 2);
}

export function wrapToolWithValidation(tool: LLMToolDefinition): LLMToolDefinition {
  if (!tool.execute) {
    return tool;
  }

  return {
    ...tool,
    execute: async (args, context) => {
      const validation = validateToolParameters(args, tool.parameters, tool.name);
      if (!validation.valid) {
        return formatToolValidationFailureArtifact({
          toolName: tool.name,
          validation,
        });
      }

      return tool.execute?.(validation.correctedArgs ?? {}, context);
    },
  };
}
