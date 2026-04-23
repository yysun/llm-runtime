import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  createLLMEnvironment,
  disposeLLMEnvironment,
  generate,
  stream,
  type BuiltInToolSelection,
  type LLMChatMessage,
  type LLMEnvironment,
  type LLMProviderConfigs,
  type LLMResponse,
  type LLMStreamChunk,
  type ReasoningEffort,
  type ToolPermission,
} from '../../../src/index.js';
import { resolveToolsAsync } from '../../../src/runtime.js';
import {
  createShowcaseWorkspace,
  summarizeChunks,
  toToolMessageContent,
  type ShowcaseWorkspace,
} from './llm-showcase-fixtures.js';

const DEFAULT_GEMINI_E2E_MODEL = 'gemini-2.5-flash';
const MAX_TOOL_TURNS = 6;
const MAX_FORMAT_RETRIES = 2;

export type ProviderE2ESelection = {
  provider: 'google' | 'azure';
  model: string;
  providers: LLMProviderConfigs;
};

export type ProviderE2EFlags = {
  help: boolean;
  dryRun: boolean;
};

type ProviderE2EScenario = {
  name: string;
  mode: 'generate' | 'stream';
  builtIns?: BuiltInToolSelection;
  reasoningEffort?: ReasoningEffort;
  toolPermission?: ToolPermission;
  messages: LLMChatMessage[];
  expectedTools: string[];
  expectedTokens: string[];
  expectedExactLines?: string[];
  assertResult?: (result: ProviderE2EScenarioResult, context: ProviderE2EScenarioContext) => Promise<void> | void;
};

type ProviderE2EScenarioResult = {
  finalText: string;
  toolNames: string[];
  chunks: LLMStreamChunk[];
  turns: number;
};

type ProviderE2EScenarioContext = {
  workingDirectory: string;
  workspace: ShowcaseWorkspace;
  environment: LLMEnvironment;
};

function extractExpectedLineBlock(text: string, expectedLines: string[]): string | null {
  const trimmedText = text.trim();
  const expected = expectedLines.join('\n');
  if (trimmedText === expected) {
    return expected;
  }

  const normalizedLines = trimmedText.split(/\r?\n/).map((line) => line.trimEnd());
  const blockLength = expectedLines.length;
  for (let index = 0; index <= normalizedLines.length - blockLength; index += 1) {
    const candidate = normalizedLines.slice(index, index + blockLength).join('\n');
    if (candidate === expected) {
      return candidate;
    }
  }

  return null;
}

function requireNonEmpty(value: string | undefined, message: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

export function parseProviderE2EFlags(argv: string[]): ProviderE2EFlags {
  const flags = new Set(argv.slice(2));
  return {
    help: flags.has('--help') || flags.has('-h'),
    dryRun: flags.has('--dry-run'),
  };
}

export function printProviderE2EHelp(command: string, envHelp: string) {
  console.log([
    `Usage: npm run ${command} -- [--dry-run]`,
    '',
    'Options:',
    '  --dry-run    Validate setup, tools, skills, and MCP wiring without calling a live LLM.',
    '  -h, --help   Show this help text.',
    '',
    envHelp,
  ].join('\n'));
}

export function resolveGeminiE2ESelection(env: NodeJS.ProcessEnv): ProviderE2ESelection | null {
  const apiKey = String(env.GOOGLE_API_KEY ?? '').trim();
  if (!apiKey) {
    return null;
  }

  return {
    provider: 'google',
    model: String(env.LLM_E2E_GEMINI_MODEL ?? env.LLM_SHOWCASE_MODEL ?? DEFAULT_GEMINI_E2E_MODEL).trim() || DEFAULT_GEMINI_E2E_MODEL,
    providers: {
      google: {
        apiKey: requireNonEmpty(env.GOOGLE_API_KEY, 'GOOGLE_API_KEY is required for the Gemini e2e suite.'),
      },
    },
  };
}

export function getGeminiE2EEnvHelp(): string {
  return [
    'Set these in the repo .env before running the Gemini e2e suite:',
    '  GOOGLE_API_KEY',
    `  LLM_E2E_GEMINI_MODEL=${DEFAULT_GEMINI_E2E_MODEL}   # optional override`,
  ].join('\n');
}

export function resolveAzureE2ESelection(env: NodeJS.ProcessEnv): ProviderE2ESelection | null {
  const apiKey = String(env.AZURE_OPENAI_API_KEY ?? '').trim();
  const resourceName = String(env.AZURE_OPENAI_RESOURCE_NAME ?? '').trim();
  const deployment = String(env.AZURE_OPENAI_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT_NAME ?? '').trim();
  if (!apiKey || !resourceName || !deployment) {
    return null;
  }

  return {
    provider: 'azure',
    model: String(env.LLM_E2E_AZURE_MODEL ?? env.LM_E2E_AZURE_MODEL ?? deployment).trim() || deployment,
    providers: {
      azure: {
        apiKey: requireNonEmpty(env.AZURE_OPENAI_API_KEY, 'AZURE_OPENAI_API_KEY is required for the Azure e2e suite.'),
        resourceName: requireNonEmpty(env.AZURE_OPENAI_RESOURCE_NAME, 'AZURE_OPENAI_RESOURCE_NAME is required for the Azure e2e suite.'),
        deployment: deployment,
        ...(String(env.AZURE_OPENAI_API_VERSION ?? '').trim()
          ? { apiVersion: String(env.AZURE_OPENAI_API_VERSION).trim() }
          : {}),
      },
    },
  };
}

export function getAzureE2EEnvHelp(): string {
  return [
    'Set these in the repo .env before running the Azure e2e suite:',
    '  AZURE_OPENAI_API_KEY',
    '  AZURE_OPENAI_RESOURCE_NAME',
    '  AZURE_OPENAI_DEPLOYMENT   # or AZURE_OPENAI_DEPLOYMENT_NAME',
    '  AZURE_OPENAI_API_VERSION=2024-10-21-preview   # optional override',
    '  LLM_E2E_AZURE_MODEL=<deployment-or-model-name>   # optional override, also accepts LM_E2E_AZURE_MODEL',
  ].join('\n');
}

function buildProviderE2EScenarios(): ProviderE2EScenario[] {
  return [
    {
      name: 'Generate: built-ins + MCP + skills + reasoning',
      mode: 'generate',
      builtIns: {
        read_file: true,
        load_skill: true,
      },
      reasoningEffort: 'high',
      expectedTools: ['read_file', 'load_skill', 'showcase_lookup_release'],
      expectedTokens: ['alpha-repo-token', 'skill-beacon-77', 'beta-signal-842'],
      messages: [
        {
          role: 'system',
          content: [
            'You are running a strict provider end-to-end suite.',
            'When the user asks for tool-backed data, you must call the relevant tools before answering.',
            'Tokens without trailing digits count as zero when comparing numeric suffixes.',
            'Return only the requested lines with no extra commentary, headings, bullets, markdown, code fences, or analysis.',
            'Any text before or after the requested lines is a test failure.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            'Use read_file on docs/repo-guide.txt, load_skill with skill_id showcase_skill, and showcase_lookup_release with subject beta.',
            'Do not answer until all three tool calls succeed.',
            'Determine which discovered token has the largest trailing integer suffix.',
            'Return exactly these four lines:',
            'REPO_TOKEN=<repo token>',
            'SKILL_TOKEN=<skill token>',
            'MCP_TOKEN=<mcp token>',
            'REASONED_WINNER=<token with the largest trailing integer suffix>',
            'Do not include any other text.',
          ].join('\n'),
        },
      ],
      expectedExactLines: [
        'REPO_TOKEN=alpha-repo-token',
        'SKILL_TOKEN=skill-beacon-77',
        'MCP_TOKEN=beta-signal-842',
        'REASONED_WINNER=beta-signal-842',
      ],
    },
    {
      name: 'Stream: built-ins + MCP + reasoning',
      mode: 'stream',
      builtIns: {
        read_file: true,
      },
      reasoningEffort: 'medium',
      expectedTools: ['read_file', 'showcase_lookup_release'],
      expectedTokens: ['stream-marker-21', 'gamma-signal-173'],
      messages: [
        {
          role: 'system',
          content: [
            'You are running a strict streaming provider end-to-end suite.',
            'You must call tools for any file-backed or MCP-backed value.',
            'Return only the requested lines at the end with no commentary, headings, bullets, markdown, code fences, or analysis.',
            'Any extra text is a test failure.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            'Use read_file on docs/stream-brief.txt and use showcase_lookup_release with subject gamma.',
            'Do not answer until both tool calls succeed.',
            'Choose the discovered token with the larger trailing integer suffix.',
            'Return exactly these three lines:',
            'STREAM_FILE_TOKEN=<file token>',
            'STREAM_MCP_TOKEN=<mcp token>',
            'STREAM_REASONED_WINNER=<token with the larger trailing integer suffix>',
            'Do not include any other text.',
          ].join('\n'),
        },
      ],
      expectedExactLines: [
        'STREAM_FILE_TOKEN=stream-marker-21',
        'STREAM_MCP_TOKEN=gamma-signal-173',
        'STREAM_REASONED_WINNER=gamma-signal-173',
      ],
    },
    {
      name: 'Generate: permission blocks write_file under read mode',
      mode: 'generate',
      builtIns: {
        write_file: true,
      },
      toolPermission: 'read',
      expectedTools: ['write_file'],
      expectedTokens: ['PERMISSION_RESULT=blocked'],
      messages: [
        {
          role: 'system',
          content: [
            'You are running a strict permission end-to-end suite.',
            'You must attempt the requested write_file call before giving a final answer.',
            'If the tool reports that it is blocked by read permission, return exactly PERMISSION_RESULT=blocked.',
            'Do not include any extra text.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            'Call write_file with path notes/blocked-write.txt and content permission-marker-44.',
            'After the tool returns, answer with exactly one line:',
            'PERMISSION_RESULT=<blocked-or-unexpected>',
          ].join('\n'),
        },
      ],
      expectedExactLines: ['PERMISSION_RESULT=blocked'],
      assertResult: async (_result, context) => {
        const blockedPath = path.join(context.workingDirectory, 'notes', 'blocked-write.txt');
        await access(blockedPath)
          .then(() => {
            assert.fail(`Expected permission-blocked path to remain absent: ${blockedPath}`);
          })
          .catch((error) => {
            const code = error && typeof error === 'object' && 'code' in error
              ? String((error as { code?: unknown }).code)
              : '';
            if (code !== 'ENOENT') {
              throw error;
            }
          });
      },
    },
  ].map((scenario) => ({
    ...scenario,
    messages: scenario.messages.map((message) => ({ ...message })),
  }));
}

async function runProviderE2EScenario(
  scenario: ProviderE2EScenario,
  context: ProviderE2EScenarioContext,
  selection: ProviderE2ESelection,
): Promise<ProviderE2EScenarioResult> {
  const messages: LLMChatMessage[] = [...scenario.messages];
  const chunks: LLMStreamChunk[] = [];
  const toolNames: string[] = [];
  const toolPermission = scenario.toolPermission ?? 'auto';
  const temperature = selection.provider === 'azure' ? undefined : 0;
  let formatRetries = 0;

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
    const response: LLMResponse = scenario.mode === 'stream'
      ? await stream({
        provider: selection.provider,
        model: selection.model,
        builtIns: scenario.builtIns,
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
        environment: context.environment,
        context: {
          workingDirectory: context.workingDirectory,
          toolPermission,
          ...(scenario.reasoningEffort ? { reasoningEffort: scenario.reasoningEffort } : {}),
        },
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
      })
      : await generate({
        provider: selection.provider,
        model: selection.model,
        builtIns: scenario.builtIns,
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
        environment: context.environment,
        context: {
          workingDirectory: context.workingDirectory,
          toolPermission,
          ...(scenario.reasoningEffort ? { reasoningEffort: scenario.reasoningEffort } : {}),
        },
      });

    if (response.type !== 'tool_calls' || !response.tool_calls?.length) {
      const normalizedActual = response.content.trim();
      const normalizedExpected = scenario.expectedExactLines?.join('\n');
      const extractedExpectedBlock = scenario.expectedExactLines
        ? extractExpectedLineBlock(response.content, scenario.expectedExactLines)
        : null;

      if (
        normalizedExpected
        && !extractedExpectedBlock
        && formatRetries < MAX_FORMAT_RETRIES
      ) {
        formatRetries += 1;
        console.log('  format retry -> previous answer did not match exact required lines');
        messages.push({
          role: 'system',
          content: [
            `Your previous answer failed formatting validation for scenario "${scenario.name}".`,
            'Return exactly the required lines and nothing else.',
            'Do not include analysis, markdown, bullets, headings, code fences, or commentary.',
            'Required exact output:',
            normalizedExpected,
          ].join('\n'),
        });
        continue;
      }

      messages.push(response.assistantMessage);

      return {
        finalText: extractedExpectedBlock ?? response.content,
        toolNames,
        chunks,
        turns: turn,
      };
    }

    messages.push(response.assistantMessage);

    const tools = await resolveToolsAsync({
      environment: context.environment,
      builtIns: scenario.builtIns,
    });

    for (const toolCall of response.tool_calls) {
      const tool = tools[toolCall.function.name];
      assert(tool?.execute, `Missing executable tool: ${toolCall.function.name}`);

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Invalid tool arguments for ${toolCall.function.name}: ${error instanceof Error ? error.message : String(error)}`);
      }

      toolNames.push(toolCall.function.name);
      console.log(`  tool -> ${toolCall.function.name}(${toolCall.function.arguments || '{}'})`);

      const toolResult = await tool.execute(parsedArgs, {
        workingDirectory: context.workingDirectory,
        toolCallId: toolCall.id,
        toolPermission,
        ...(scenario.reasoningEffort ? { reasoningEffort: scenario.reasoningEffort } : {}),
      });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toToolMessageContent(toolResult),
      });
    }
  }

  throw new Error(`Scenario exceeded ${MAX_TOOL_TURNS} tool rounds without reaching a final answer.`);
}

function assertProviderE2EScenario(
  scenario: ProviderE2EScenario,
  result: ProviderE2EScenarioResult,
) {
  for (const expectedTool of scenario.expectedTools) {
    assert(
      result.toolNames.includes(expectedTool),
      `Expected tool "${expectedTool}" to be used in scenario "${scenario.name}". Used tools: ${result.toolNames.join(', ') || '(none)'}`,
    );
  }

  for (const expectedToken of scenario.expectedTokens) {
    assert(
      result.finalText.includes(expectedToken),
      `Expected token "${expectedToken}" in scenario "${scenario.name}" final text.\nFinal text:\n${result.finalText}`,
    );
  }

  if (scenario.expectedExactLines) {
    const normalizedActual = extractExpectedLineBlock(result.finalText, scenario.expectedExactLines) ?? result.finalText.trim();
    const normalizedExpected = scenario.expectedExactLines.join('\n');
    assert.equal(
      normalizedActual,
      normalizedExpected,
      `Expected exact final text for scenario "${scenario.name}".\nExpected:\n${normalizedExpected}\n\nActual:\n${normalizedActual}`,
    );
  }

  if (scenario.mode === 'stream') {
    assert(
      result.chunks.length > 0,
      `Expected streaming chunks for scenario "${scenario.name}".`,
    );
  }
}

export async function runProviderE2ESuite(options: {
  selection: ProviderE2ESelection;
  suiteLabel: string;
  dryRun: boolean;
}) {
  const workspace = await createShowcaseWorkspace();
  const environment = createLLMEnvironment({
    providers: options.selection.providers,
    mcpConfig: {
      servers: {
        showcase: {
          command: process.execPath,
          args: [path.resolve('tests/e2e/support/llm-showcase-mcp-server.mjs')],
          transport: 'stdio',
          env: { ...process.env },
        },
      },
    },
    skillRoots: workspace.skillRoots,
  });

  try {
    console.log(options.suiteLabel);
    console.log(`provider=${options.selection.provider}`);
    console.log(`model=${options.selection.model}`);

    const resolvedTools = await resolveToolsAsync({
      environment,
      builtIns: {
        read_file: true,
        load_skill: true,
        write_file: true,
        human_intervention_request: false,
        shell_cmd: false,
        web_fetch: false,
        list_files: false,
        grep: false,
      },
    });
    console.log(`tools=${Object.keys(resolvedTools).join(', ')}`);

    if (options.dryRun) {
      for (const scenario of buildProviderE2EScenarios()) {
        console.log(`dry-run scenario=${scenario.name}`);
      }
      console.log('dry-run=ok');
      return;
    }

    for (const scenario of buildProviderE2EScenarios()) {
      console.log(`\n[scenario] ${scenario.name}`);
      const context: ProviderE2EScenarioContext = {
        workingDirectory: workspace.rootPath,
        workspace,
        environment,
      };
      const result = await runProviderE2EScenario(scenario, context, options.selection);
      assertProviderE2EScenario(scenario, result);
      await scenario.assertResult?.(result, context);
      console.log(`  tools used: ${result.toolNames.join(', ') || '(none)'}`);
      if (scenario.mode === 'stream') {
        console.log(`  stream summary: ${summarizeChunks(result.chunks) || '(no visible text chunks)'}`);
      }
      console.log(`  final answer:\n${result.finalText}`);
      console.log(`  status: PASS in ${result.turns} turn(s)`);
    }

    console.log('\nprovider e2e status: PASS');
  } finally {
    await disposeLLMEnvironment(environment).catch(() => undefined);
    await rm(path.dirname(workspace.rootPath), { recursive: true, force: true }).catch(() => undefined);
  }
}