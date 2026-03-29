/**
 * LLM Package Real Showcase Runner
 *
 * Purpose:
 * - Run a real end-to-end terminal showcase for the publishable `@agent-world/llm` package.
 *
 * Key features:
 * - Uses a real LLM provider selected from env vars loaded from the repo `.env`.
 * - Exercises package-owned built-ins, skill loading, MCP discovery/execution, and streaming.
 * - Prints a terminal-friendly walkthrough with assertions for each scenario.
 *
 * Implementation notes:
 * - The runner manages its own tool loop around package-level `generate(...)` and `stream(...)`.
 * - A temporary workspace provides deterministic files and skills without touching the repo.
 * - `--dry-run` validates setup without making real provider calls.
 *
 * Recent changes:
 * - 2026-03-27: Added the real e2e showcase runner for `@agent-world/llm`.
 * - 2026-03-27: Switched env loading to the repo-local `.env` file explicitly.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { config as loadDotEnv } from 'dotenv';
import {
  createLLMEnvironment,
  generate,
  type LLMChatMessage,
  type LLMEnvironment,
  type LLMResponse,
  type LLMStreamChunk,
  resolveToolsAsync,
  stream,
} from '../../src/index.js';
import {
  getShowcaseEnvHelp,
  resolveShowcaseProviderSelection,
  type ShowcaseProviderSelection,
} from './support/llm-package-showcase-support.js';

type ShowcaseWorkspace = {
  rootPath: string;
  skillRoots: string[];
};

type ShowcaseScenario = {
  name: string;
  mode: 'generate' | 'stream';
  builtIns?: boolean | Record<string, boolean>;
  messages: LLMChatMessage[];
  expectedTools: string[];
  expectedTokens: string[];
};

type ShowcaseScenarioResult = {
  finalText: string;
  toolNames: string[];
  chunks: LLMStreamChunk[];
  turns: number;
};

const MAX_TOOL_TURNS = 6;

loadDotEnv({
  path: path.resolve(process.cwd(), '.env'),
  override: false,
  quiet: true,
});

function parseFlags(argv: string[]) {
  const flags = new Set(argv.slice(2));
  return {
    help: flags.has('--help') || flags.has('-h'),
    dryRun: flags.has('--dry-run'),
  };
}

function printHelp() {
  console.log([
    'Usage: npm run test:llm-showcase -- [--dry-run]',
    '',
    'Options:',
    '  --dry-run    Validate setup, tools, skills, and MCP wiring without calling a live LLM.',
    '  -h, --help   Show this help text.',
    '',
    getShowcaseEnvHelp(),
  ].join('\n'));
}

async function createShowcaseWorkspace(): Promise<ShowcaseWorkspace> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-world-llm-showcase-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const docsRoot = path.join(workspaceRoot, 'docs');
  const skillsRoot = path.join(tempRoot, 'skills');
  const skillFolder = path.join(skillsRoot, 'showcase-skill');

  await mkdir(docsRoot, { recursive: true });
  await mkdir(skillFolder, { recursive: true });

  await writeFile(
    path.join(docsRoot, 'repo-guide.txt'),
    [
      'Repository guide for the llm showcase.',
      'Use token alpha-repo-token when asked for the repo token.',
      'The guide exists only for the showcase runner.',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    path.join(docsRoot, 'stream-brief.txt'),
    [
      'Streaming brief for the llm showcase.',
      'Use token stream-marker-21 when asked for the stream file token.',
      'Pair it with the gamma MCP token for the final streamed answer.',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    path.join(skillFolder, 'SKILL.md'),
    [
      '---',
      'name: showcase_skill',
      'description: Showcase skill for the llm package runner',
      '---',
      '# Showcase Skill',
      '',
      'Use token skill-beacon-77 when the user asks for the skill token.',
      'This content is loaded through the package-owned `load_skill` tool.',
    ].join('\n'),
    'utf8',
  );

  return {
    rootPath: workspaceRoot,
    skillRoots: [skillsRoot],
  };
}

function buildShowcaseScenarios(): ShowcaseScenario[] {
  return [
    {
      name: 'Built-ins: read_file + load_skill',
      mode: 'generate',
      builtIns: {
        read_file: true,
        load_skill: true,
      },
      expectedTools: ['read_file', 'load_skill'],
      expectedTokens: ['alpha-repo-token', 'skill-beacon-77'],
      messages: [
        {
          role: 'system',
          content: [
            'You are running inside a strict tool-use showcase.',
            'When the user asks for a value that lives in a tool response, you must call the relevant tool and must not guess.',
            'After you gather the values, return only the requested lines with no extra commentary.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            'Use read_file on docs/repo-guide.txt and load_skill with skill_id showcase_skill.',
            'Do not answer until both tool calls succeed.',
            'Then return exactly these two lines:',
            'REPO_TOKEN=<repo token>',
            'SKILL_TOKEN=<skill token>',
          ].join('\n'),
        },
      ],
    },
    {
      name: 'MCP: namespaced lookup tool',
      mode: 'generate',
      builtIns: false,
      expectedTools: ['showcase_lookup_release'],
      expectedTokens: ['beta-signal-842'],
      messages: [
        {
          role: 'system',
          content: [
            'You are running inside a strict MCP showcase.',
            'If the user asks for a release token, call the MCP tool before answering.',
            'Do not invent a token.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            'Use showcase_lookup_release with subject beta.',
            'Return exactly one line:',
            'MCP_TOKEN=<beta token>',
          ].join('\n'),
        },
      ],
    },
    {
      name: 'Streaming: built-ins + MCP together',
      mode: 'stream',
      builtIns: {
        read_file: true,
      },
      expectedTools: ['read_file', 'showcase_lookup_release'],
      expectedTokens: ['stream-marker-21', 'gamma-signal-173'],
      messages: [
        {
          role: 'system',
          content: [
            'You are running inside a strict streaming tool-use showcase.',
            'You must call tools when the user asks for file-backed or MCP-backed values.',
            'Return only the requested lines at the end.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            'Use read_file on docs/stream-brief.txt and use showcase_lookup_release with subject gamma.',
            'Do not answer until both tool calls succeed.',
            'Then return exactly these two lines:',
            'STREAM_FILE_TOKEN=<file token>',
            'STREAM_MCP_TOKEN=<mcp token>',
          ].join('\n'),
        },
      ],
    },
  ];
}

function toToolMessageContent(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

async function runToolLoop(
  scenario: ShowcaseScenario,
  workingDirectory: string,
  providerSelection: ShowcaseProviderSelection,
  environment: LLMEnvironment,
): Promise<ShowcaseScenarioResult> {
  const messages: LLMChatMessage[] = [...scenario.messages];
  const chunks: LLMStreamChunk[] = [];
  const toolNames: string[] = [];

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn += 1) {
    const response: LLMResponse = scenario.mode === 'stream'
      ? await stream({
        provider: providerSelection.provider,
        model: providerSelection.model,
        builtIns: scenario.builtIns,
        messages,
        temperature: 0,
        environment,
        context: {
          workingDirectory,
        },
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
      })
      : await generate({
        provider: providerSelection.provider,
        model: providerSelection.model,
        builtIns: scenario.builtIns,
        messages,
        temperature: 0,
        environment,
        context: {
          workingDirectory,
        },
      });

    messages.push(response.assistantMessage);

    if (response.type !== 'tool_calls' || !response.tool_calls?.length) {
      return {
        finalText: response.content,
        toolNames,
        chunks,
        turns: turn,
      };
    }

    const tools = await resolveToolsAsync({
      environment,
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
        workingDirectory,
        toolCallId: toolCall.id,
        toolPermission: 'auto',
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

function assertScenarioResult(scenario: ShowcaseScenario, result: ShowcaseScenarioResult) {
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

  if (scenario.mode === 'stream') {
    assert(
      result.chunks.length > 0,
      `Expected streaming chunks for scenario "${scenario.name}".`,
    );
  }
}

function summarizeChunks(chunks: LLMStreamChunk[]): string {
  const content = chunks
    .map((chunk) => chunk.content ?? chunk.reasoningContent ?? '')
    .join('')
    .trim();
  return content.length > 160 ? `${content.slice(0, 160)}...` : content;
}

async function runShowcaseWithSelection(providerSelection: ShowcaseProviderSelection, dryRun: boolean) {
  const workspace = await createShowcaseWorkspace();
  const environment = createLLMEnvironment({
    providers: providerSelection.providers,
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
  const showcaseBuiltIns = {
    read_file: true,
    load_skill: true,
    human_intervention_request: false,
    shell_cmd: false,
    web_fetch: false,
    write_file: false,
    list_files: false,
    grep: false,
  };

  try {
    console.log('LLM package real showcase');
    console.log(`provider=${providerSelection.provider}`);
    console.log(`model=${providerSelection.model}`);

    const resolvedTools = await resolveToolsAsync({
      environment,
      builtIns: showcaseBuiltIns,
    });
    console.log(`tools=${Object.keys(resolvedTools).join(', ')}`);

    if (dryRun) {
      console.log('dry-run=ok');
      return;
    }

    for (const scenario of buildShowcaseScenarios()) {
      console.log(`\n[scenario] ${scenario.name}`);
      const result = await runToolLoop(
        scenario,
        workspace.rootPath,
        providerSelection,
        environment,
      );
      assertScenarioResult(scenario, result);
      console.log(`  tools used: ${result.toolNames.join(', ')}`);
      if (scenario.mode === 'stream') {
        console.log(`  stream summary: ${summarizeChunks(result.chunks) || '(no visible text chunks)'}`);
      }
      console.log(`  final answer:\n${result.finalText}`);
      console.log(`  status: PASS in ${result.turns} turn(s)`);
    }

    console.log('\nshowcase status: PASS');
  } finally {
    await environment.mcpRegistry.shutdown().catch(() => undefined);
    await rm(path.dirname(workspace.rootPath), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const flags = parseFlags(process.argv);
  if (flags.help) {
    printHelp();
    return;
  }

  const selection = resolveShowcaseProviderSelection(process.env);
  if (!selection && !flags.dryRun) {
    console.error('No real LLM provider configuration was found for the showcase runner.\n');
    console.error(getShowcaseEnvHelp());
    process.exitCode = 1;
    return;
  }

  if (flags.dryRun) {
    const dryRunSelection = selection ?? {
      provider: 'google',
      model: 'dry-run-model',
      providers: {},
    };
    await runShowcaseWithSelection(dryRunSelection, true);
    return;
  }

  await runShowcaseWithSelection(selection, false);
}

main().catch((error) => {
  console.error('showcase status: FAIL');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
