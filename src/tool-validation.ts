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
 * - 2026-05-18: Added `write_file` path alias normalization so validation matches the file-tool schema contract.
 * - 2026-03-27: Added package-owned validation for built-in tool execution.
 * - 2026-05-14: Updated filesystem built-in alias normalization for the new tool surface.
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

function getValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

function joinPath(basePath: string, segment: string): string {
  if (!basePath || basePath === '$') {
    return segment;
  }
  return `${basePath}.${segment}`;
}

function normalizeRequiredPath(basePath: string, key: string): string {
  return basePath === '$' ? key : joinPath(basePath, key);
}

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

  if (
    toolName === 'write_file'
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

  if (toolName === 'search_files' && normalizedArgs.pattern === undefined && normalizedArgs.query !== undefined) {
    normalizedArgs.pattern = normalizedArgs.query;
    delete normalizedArgs.query;
    corrections.push('query -> pattern');
  }

  if (toolName === 'search_files' && normalizedArgs.path === undefined && normalizedArgs.directory !== undefined) {
    normalizedArgs.path = normalizedArgs.directory;
    delete normalizedArgs.directory;
    corrections.push('directory -> path');
  }

  if (toolName === 'create_directory' && normalizedArgs.path === undefined && normalizedArgs.directory !== undefined) {
    normalizedArgs.path = normalizedArgs.directory;
    delete normalizedArgs.directory;
    corrections.push('directory -> path');
  }

  if (toolName === 'path_exists' && normalizedArgs.path === undefined && normalizedArgs.filePath !== undefined) {
    normalizedArgs.path = normalizedArgs.filePath;
    delete normalizedArgs.filePath;
    corrections.push('filePath -> path');
  }

  if (toolName === 'path_exists' && normalizedArgs.path === undefined && normalizedArgs.directory !== undefined) {
    normalizedArgs.path = normalizedArgs.directory;
    delete normalizedArgs.directory;
    corrections.push('directory -> path');
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
  const issues: ToolValidationIssue[] = [];

  function validateValue(
    value: unknown,
    schema: Record<string, unknown> | undefined,
    path: string,
  ): unknown {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return value;
    }

    const schemaType = typeof schema.type === 'string'
      ? schema.type
      : schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
        ? 'object'
        : undefined;

    if (schemaType === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must be an object, got: ${getValueType(value)}`,
          expectedType: 'object',
          receivedType: getValueType(value),
        });
        return undefined;
      }

      const objectValue = value as Record<string, unknown>;
      const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
        ? schema.properties as Record<string, Record<string, unknown>>
        : {};
      const requiredParams = Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const allowsAdditionalProperties = schema.additionalProperties !== false;
      const correctedObject: Record<string, unknown> = {};

      for (const requiredParam of requiredParams) {
        const requiredValue = objectValue[requiredParam];
        if (requiredValue === undefined || requiredValue === null || requiredValue === '') {
          issues.push({
            path: normalizeRequiredPath(path, requiredParam),
            code: 'missing_required',
            message: `Required parameter '${normalizeRequiredPath(path, requiredParam)}' is missing or empty`,
          });
        }
      }

      for (const [key, entryValue] of Object.entries(objectValue)) {
        const propSchema = properties[key];
        if (!propSchema) {
          if (!allowsAdditionalProperties) {
            issues.push({
              path: normalizeRequiredPath(path, key),
              code: 'unknown_parameter',
              message: `Unknown parameter '${normalizeRequiredPath(path, key)}' is not allowed`,
            });
            continue;
          }

          correctedObject[key] = entryValue;
          continue;
        }

        if ((entryValue === undefined || entryValue === null || entryValue === '') && !requiredParams.includes(key)) {
          continue;
        }

        const correctedValue = validateValue(entryValue, propSchema, normalizeRequiredPath(path, key));
        if (correctedValue !== undefined) {
          correctedObject[key] = correctedValue;
        }
      }

      return correctedObject;
    }

    if (schemaType === 'array') {
      const normalizedArrayValue = typeof value === 'string' && value !== '' ? [value] : value;
      if (!Array.isArray(normalizedArrayValue)) {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must be an array, got: ${getValueType(value)}`,
          expectedType: 'array',
          receivedType: getValueType(value),
        });
        return undefined;
      }

      const minItems = typeof schema.minItems === 'number' ? schema.minItems : undefined;
      if (minItems !== undefined && normalizedArrayValue.length < minItems) {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must contain at least ${minItems} item(s)`,
          expectedType: `array(minItems=${minItems})`,
          receivedType: `array(length=${normalizedArrayValue.length})`,
        });
      }

      const itemSchema = schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
        ? schema.items as Record<string, unknown>
        : undefined;
      return normalizedArrayValue.map((entryValue, index) => validateValue(entryValue, itemSchema, `${path}[${index}]`));
    }

    if (schemaType === 'number' || schemaType === 'integer') {
      const normalizedNumber = typeof value === 'string' ? Number(value) : value;
      if (typeof normalizedNumber !== 'number' || Number.isNaN(normalizedNumber)) {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must be a ${schemaType}, got: ${getValueType(value)}`,
          expectedType: schemaType,
          receivedType: getValueType(value),
        });
        return undefined;
      }

      if (schemaType === 'integer' && !Number.isInteger(normalizedNumber)) {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must be an integer, got: ${normalizedNumber}`,
          expectedType: 'integer',
          receivedType: 'number',
        });
        return undefined;
      }

      if (Array.isArray(schema.enum) && !schema.enum.includes(normalizedNumber)) {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must be one of ${schema.enum.join(', ')}`,
          expectedType: `enum(${schema.enum.join(', ')})`,
          receivedType: String(normalizedNumber),
        });
        return undefined;
      }

      return normalizedNumber;
    }

    if (schemaType === 'boolean') {
      if (typeof value !== 'boolean') {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must be a boolean, got: ${getValueType(value)}`,
          expectedType: 'boolean',
          receivedType: getValueType(value),
        });
        return undefined;
      }

      return value;
    }

    if (schemaType === 'string') {
      if (typeof value !== 'string') {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must be a string, got: ${getValueType(value)}`,
          expectedType: 'string',
          receivedType: getValueType(value),
        });
        return undefined;
      }

      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        issues.push({
          path,
          code: 'invalid_type',
          message: `Parameter '${path}' must be one of ${schema.enum.join(', ')}`,
          expectedType: `enum(${schema.enum.join(', ')})`,
          receivedType: value,
        });
        return undefined;
      }

      return value;
    }

    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      issues.push({
        path,
        code: 'invalid_type',
        message: `Parameter '${path}' must be one of ${schema.enum.join(', ')}`,
        expectedType: `enum(${schema.enum.join(', ')})`,
        receivedType: String(value),
      });
      return undefined;
    }

    return value;
  }

  const correctedArgs = validateValue(normalizedArgs, {
    type: 'object',
    properties: schemaProperties as Record<string, unknown>,
    required: Array.isArray(toolSchema.required) ? toolSchema.required : [],
    additionalProperties: toolSchema.additionalProperties,
  }, '$');

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
    correctedArgs: correctedArgs as Record<string, unknown>,
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
