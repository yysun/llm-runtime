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
 * - `human_intervention_request` returns a package-owned pending request artifact.
 *
 * Recent changes:
 * - 2026-03-27: Added package-owned built-in tool catalog and selection helpers.
 * - 2026-05-14: Replaced `grep` with `search_files`, `create_directory`, and `path_exists`.
 */

import { wrapToolWithValidation } from './tool-validation.js';
import { createBuiltInExecutors } from './builtin-executors.js';
import type {
  BuiltInToolName,
  BuiltInToolSelection,
  LLMToolDefinition,
  SkillRegistry,
} from './types.js';

export const BUILT_IN_TOOL_NAMES = [
  'shell_cmd',
  'load_skill',
  'human_intervention_request',
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
  'human_intervention_request',
  'ask_user_input',
] as const satisfies readonly BuiltInToolName[];
const HUMAN_INTERVENTION_BUILT_IN_TOOL_NAME_SET = new Set<BuiltInToolName>(HUMAN_INTERVENTION_BUILT_IN_TOOL_NAMES);
const BUILT_IN_TOOL_NAME_SET = new Set<string>(BUILT_IN_TOOL_NAMES);

type BuiltInToolToggleMap = Record<BuiltInToolName, boolean>;

const HUMAN_INPUT_PARAMETERS = {
  type: 'object',
  description:
    'Provide questions[] with stable ids and options. Flat question/options payloads are not supported.',
  properties: {
    type: {
      type: 'string',
      enum: ['single-select', 'multiple-select'],
      description:
        'Selection mode for all questions. Use single-select for exactly one choice, multiple-select when the human may choose more than one. Omit to default to single-select. Do not use kind or approval.',
    },
    allowSkip: {
      type: 'boolean',
      description:
        'Set true only for explicitly dismissible, non-blocking prompts when it is acceptable for the human to skip without choosing. Do not use allowSkip for approval-gated or otherwise blocking decisions. Omit or false when an answer is required before continuing.',
    },
    questions: {
      type: 'array',
      description:
        'Required field. Provide one or more structured questions; each question must include at least two options.',
      items: {
        type: 'object',
        description: 'One question to show to the human.',
        properties: {
          header: {
            type: 'string',
            description:
              'Short UI header, usually 1-3 words, such as "Approval", "Scope", or "Tests".',
          },
          id: {
            type: 'string',
            description:
              'Stable machine-readable question id. Use lowercase kebab-case or snake_case, such as "test-scope" or "deploy_approval".',
          },
          question: {
            type: 'string',
            description:
              'Clear question shown to the human. Ask for the missing decision or input directly.',
          },
          options: {
            type: 'array',
            description:
              'Selectable options. Provide at least two options. Use stable option ids for answer handling; labels are display text.',
            items: {
              type: 'object',
              description: 'One selectable option.',
              properties: {
                id: {
                  type: 'string',
                  description:
                    'Stable machine-readable option id. Prefer lowercase kebab-case or snake_case, such as "approve", "reject", "run-tests", or "skip-tests".',
                },
                label: {
                  type: 'string',
                  description:
                    'Short user-facing option label, such as "Approve", "Reject", or "Run tests".',
                },
                description: {
                  type: 'string',
                  description:
                    'Optional one-sentence clarification of what selecting this option means.',
                },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
          },
        },
        required: ['header', 'id', 'question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

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
  human_intervention_request: {
    description:
      'Legacy alias of `ask_user_input`. Prefer `ask_user_input` for new prompts. When this alias is used, ask a human one or more structured choice questions by sending questions[] with stable question and option ids. Supports single-select, multiple-select, and skip-capable prompts. Do not add a kind field; use type and allowSkip. Do not use allowSkip for approval-gated or otherwise blocking decisions; reserve it for explicitly dismissible, non-blocking prompts.',
    parameters: HUMAN_INPUT_PARAMETERS,
  },
  ask_user_input: {
    description:
      'Ask a human one or more structured choice questions. Prefer this tool whenever clarification, approval, missing user input, or another human decision is needed. Use questions[] with stable lowercase question and option ids. Use type: single-select or multiple-select; omit type to default to single-select. Set allowSkip true only for explicitly dismissible, non-blocking prompts when skipping is acceptable; do not use allowSkip for approval-gated or otherwise blocking decisions. Do not add a kind field or approval type. Flat question/options payloads are not supported. Legacy alias name: `human_intervention_request`.',
    parameters: HUMAN_INPUT_PARAMETERS,
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
  if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
    assertKnownBuiltInSelectionKeys(selection as Partial<Record<string, unknown>>);
  }
  const humanInterventionEnabled = selection === undefined || selection === true
    ? true
    : selection === false
      ? false
      : selection.human_intervention_request === true || selection.ask_user_input === true;

  for (const toolName of BUILT_IN_TOOL_NAMES) {
    if (HUMAN_INTERVENTION_BUILT_IN_TOOL_NAME_SET.has(toolName)) {
      resolved[toolName] = humanInterventionEnabled;
      continue;
    }

    resolved[toolName] = selection === undefined || selection === true
      ? true
      : selection === false
        ? false
        : selection[toolName] === true;
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
