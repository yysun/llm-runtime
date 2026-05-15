/**
 * LLM Package Built-In Tool Catalog
 *
 * Purpose:
 * - Own the canonical built-in tool catalog for `llm-runtime`.
 *
 * Key features:
 * - Stable built-in tool names, descriptions, and parameter schemas.
 * - Constructor-time enable/disable control with optional per-call narrowing support.
 * - Internal built-in executors, including package-owned HITL pending-request generation.
 *
 * Implementation notes:
 * - The package owns the built-in catalog and enablement policy.
 * - File, shell, web, and skill built-ins execute inside the package.
 * - `ask_user_input` is the public HITL built-in.
 *
 * Recent changes:
 * - 2026-05-15: Tightened HITL tool descriptions to direct the model to safe read-only inspection or lookup before asking the user.
 * - 2026-05-15: Removed deprecated HITL alias tools from the public built-in surface.
 * - 2026-05-15: Changed the default built-in exposure to a read-only set.
 * - 2026-03-27: Added package-owned built-in tool catalog and selection helpers.
 * - 2026-05-14: Replaced `grep` with `search_files`, `create_directory`, and `path_exists`.
 */

import { wrapToolWithValidation } from './tool-validation.js';
import { createBuiltInExecutors } from './builtin-executors.js';
import {
  ASK_USER_INPUT_TOOL_DESCRIPTION,
  ASK_USER_INPUT_TOOL_PARAMETERS,
} from './human-input-contract.js';
import type {
  BuiltInToolName,
  BuiltInToolSelection,
  LLMToolDefinition,
  SkillRegistry,
} from './types.js';

export const BUILT_IN_TOOL_NAMES = [
  'shell_cmd',
  'load_skill',
  'ask_user_input',
  'web_fetch',
  'read_file',
  'write_file',
  'list_files',
  'search_files',
  'create_directory',
  'path_exists',
] as const satisfies readonly BuiltInToolName[];

export const HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES = [
  'ask_user_input',
] as const satisfies readonly BuiltInToolName[];
export const DEFAULT_READ_ONLY_BUILT_IN_TOOL_NAMES = [
  'load_skill',
  'read_file',
  'list_files',
  'search_files',
  'path_exists',
] as const satisfies readonly BuiltInToolName[];
const HUMAN_INTERVENTION_BUILT_IN_TOOL_NAME_SET = new Set<BuiltInToolName>(HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES);
const BUILT_IN_TOOL_NAME_SET = new Set<string>(BUILT_IN_TOOL_NAMES);
const DEFAULT_READ_ONLY_BUILT_IN_TOOL_NAME_SET = new Set<BuiltInToolName>(DEFAULT_READ_ONLY_BUILT_IN_TOOL_NAMES);

type BuiltInToolToggleMap = Record<BuiltInToolName, boolean>;

const BUILT_IN_TOOL_CATALOG: Record<BuiltInToolName, Omit<LLMToolDefinition, 'name' | 'execute'>> = {
  shell_cmd: {
    description:
      'Execute a user-requested shell command and capture output. Prefer the structured workspace tools (`list_files`, `search_files`, `read_file`, `path_exists`, `create_directory`) for routine workspace discovery and inspection. Use this tool when the user explicitly asks to run a command, when you need git or other command-specific behavior, or when the structured tools do not cover the task.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (for example: "ls", "cat", "pwd").',
        },
        parameters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional command arguments. Pass each argument as a separate token.',
        },
        directory: {
          type: 'string',
          description: 'Optional target directory inside trusted working-directory scope.',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds.',
        },
        output_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Optional output format.',
        },
        output_detail: {
          type: 'string',
          enum: ['minimal', 'full'],
          description: 'Optional output detail level.',
        },
        artifact_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to include as artifacts.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  load_skill: {
    description:
      'Load the full instructions for a known skill by `skill_id` and return the skill context payload.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: 'Required skill id to load.',
        },
      },
      required: ['skill_id'],
      additionalProperties: false,
    },
  },
  ask_user_input: {
    description: ASK_USER_INPUT_TOOL_DESCRIPTION,
    parameters: ASK_USER_INPUT_TOOL_PARAMETERS,
  },
  web_fetch: {
    description:
      'Fetch a URL and convert response content to markdown. Supports lightweight SPA data extraction from embedded JSON state without running a browser renderer.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Target URL to fetch. Only http/https schemes are allowed.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional request timeout in milliseconds.',
        },
        maxChars: {
          type: 'number',
          description: 'Optional maximum markdown output characters.',
        },
        includeLinks: {
          type: 'boolean',
          description: 'When false, link URLs are stripped and only anchor text is kept.',
        },
        includeImages: {
          type: 'boolean',
          description: 'When true, image markdown is preserved.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  read_file: {
    description:
      'Read file contents with bounded line pagination. Relative paths resolve from the trusted working directory. Prefer this over `shell_cmd` for routine file inspection.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Target file path.',
        },
        path: {
          type: 'string',
          description: 'Alias for filePath.',
        },
        offset: {
          type: 'number',
          description: '1-based line number to start reading from.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to return.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  write_file: {
    description:
      'Write text content to a file inside the trusted working-directory scope.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Target file path.',
        },
        path: {
          type: 'string',
          description: 'Alias for filePath.',
        },
        content: {
          type: 'string',
          description: 'UTF-8 text content to write.',
        },
        mode: {
          type: 'string',
          enum: ['create', 'overwrite'],
          description: 'Optional write mode.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  list_files: {
    description:
      'List file and directory names for quick workspace exploration. Prefer this over `shell_cmd` for routine directory listing inside the trusted working-directory scope.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional directory path to list.',
        },
        includeHidden: {
          type: 'boolean',
          description: 'Include dot-prefixed files and folders when true.',
        },
        recursive: {
          type: 'boolean',
          description: 'When true, include nested entries.',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth when recursive.',
        },
        includePattern: {
          type: 'string',
          description: 'Optional glob-like filter.',
        },
        maxEntries: {
          type: 'number',
          description: 'Maximum number of returned entries.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  search_files: {
    description:
      'Search for files by glob-like pattern inside the trusted working-directory scope. Prefer this over `shell_cmd` for routine file discovery.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob-like file pattern to search for, for example "**/*.ts" or "src/**/index.ts".',
        },
        path: {
          type: 'string',
          description: 'Optional root directory for the file search.',
        },
        includeHidden: {
          type: 'boolean',
          description: 'When true, include dot-prefixed files and folders in the search.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of matched file paths to return.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  create_directory: {
    description:
      'Create a directory path inside the trusted working-directory scope, including missing parent directories. Prefer this over `shell_cmd` for routine directory creation.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to create.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  path_exists: {
    description:
      'Check whether a file or directory path exists inside the trusted working-directory scope. Prefer this over `shell_cmd` for routine file or directory existence checks.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory path to check.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

function assertKnownBuiltInSelectionKeys(selection: Partial<Record<string, unknown>>): void {
  for (const key of Object.keys(selection)) {
    if (!BUILT_IN_TOOL_NAME_SET.has(key)) {
      throw new Error(`Unknown built-in tool name "${key}".`);
    }
  }
}

function toToggleMap(selection: BuiltInToolSelection | undefined): BuiltInToolToggleMap {
  const resolved = {} as BuiltInToolToggleMap;
  const selectionMap = selection && typeof selection === 'object' && !Array.isArray(selection)
    ? selection as Partial<Record<BuiltInToolName, boolean>>
    : undefined;
  if (selectionMap) {
    assertKnownBuiltInSelectionKeys(selectionMap as Partial<Record<string, unknown>>);
  }

  const selectionMode = selection === undefined
    ? 'read-only'
    : selection === true
      ? 'all'
      : selection === false
        ? 'none'
        : selection === 'all' || selection === 'read-only'
          ? selection
          : 'map';

  const humanInterventionEnabled = selectionMode === 'all'
    ? true
    : selectionMode === 'read-only' || selectionMode === 'none'
      ? false
      : selectionMap?.ask_user_input === true;

  for (const toolName of BUILT_IN_TOOL_NAMES) {
    if (HUMAN_INTERVENTION_BUILT_IN_TOOL_NAME_SET.has(toolName)) {
      resolved[toolName] = humanInterventionEnabled;
      continue;
    }

    resolved[toolName] = selectionMode === 'all'
      ? true
      : selectionMode === 'read-only'
        ? DEFAULT_READ_ONLY_BUILT_IN_TOOL_NAME_SET.has(toolName)
        : selectionMode === 'none'
          ? false
          : selectionMap?.[toolName] === true;
  }
  return resolved;
}

export function normalizeBuiltInToolSelection(
  selection: BuiltInToolSelection | undefined,
): Record<BuiltInToolName, boolean> {
  return { ...toToggleMap(selection) };
}

export function intersectBuiltInToolSelections(
  baseline: BuiltInToolSelection | undefined,
  narrowing: BuiltInToolSelection | undefined,
): Record<BuiltInToolName, boolean> {
  const baselineMap = toToggleMap(baseline);

  if (narrowing === undefined || narrowing === true) {
    return baselineMap;
  }

  if (narrowing === false) {
    return Object.fromEntries(BUILT_IN_TOOL_NAMES.map((toolName) => [toolName, false])) as Record<BuiltInToolName, boolean>;
  }

  const narrowingMap = toToggleMap(narrowing);

  return Object.fromEntries(
    BUILT_IN_TOOL_NAMES.map((toolName) => [toolName, baselineMap[toolName] && narrowingMap[toolName]]),
  ) as Record<BuiltInToolName, boolean>;
}

export function createBuiltInToolDefinitions(options: {
  builtIns?: BuiltInToolSelection;
  skillRegistry: SkillRegistry;
}): Record<string, LLMToolDefinition> {
  const enabled = toToggleMap(options.builtIns);
  const executors = createBuiltInExecutors({
    skillRegistry: options.skillRegistry,
  });

  return Object.fromEntries(
    BUILT_IN_TOOL_NAMES
      .filter((toolName) => enabled[toolName])
      .map((toolName) => {
        const catalogEntry = BUILT_IN_TOOL_CATALOG[toolName];

        const definition = wrapToolWithValidation({
          name: toolName,
          description: catalogEntry.description,
          parameters: catalogEntry.parameters,
          execute: executors[toolName],
        });

        return [toolName, definition];
      }),
  );
}

export function assertNoBuiltInToolNameCollisions(tools: LLMToolDefinition[]): void {
  for (const tool of tools) {
    if (BUILT_IN_TOOL_NAMES.includes(tool.name as BuiltInToolName)) {
      throw new Error(`Tool name "${tool.name}" is reserved by llm-runtime built-ins.`);
    }
  }
}
