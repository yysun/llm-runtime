/**
 * LLM Package Real Showcase Runner
 *
 * Purpose:
 * - Run a real end-to-end terminal showcase for the publishable `llm-runtime` package.
 *
 * Key features:
 * - Uses a real LLM provider selected from env vars loaded from the repo `.env`.
 * - Exercises the public runtime facade across built-ins, skill loading, MCP discovery/execution, and streaming events.
 * - Prints a terminal-friendly walkthrough with assertions for each scenario.
 *
 * Implementation notes:
 * - The runner uses `runtime.complete(...)` and `runtime.streamComplete(...)` as the current public example path.
 * - A temporary workspace provides deterministic files and skills without touching the repo.
 * - `--dry-run` validates setup without making real provider calls.
 *
 * Recent changes:
 * - 2026-05-27: Reworked the showcase around the narrowed public root API and runtime facade.
 * - 2026-03-27: Added the real e2e showcase runner for `llm-runtime`.
 * - 2026-03-27: Switched env loading to the repo-local `.env` file explicitly.
 * - 2026-05-14: Updated showcase built-in selections for the filesystem tool surface.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { config as loadDotEnv } from 'dotenv';
import {
  createRuntime,
  type LLMChatMessage,
  type LLMRuntime,
  type LLMStreamChunk,
} from '../../src/index.js';
import {
  getShowcaseEnvHelp,
  resolveShowcaseProviderSelection,
  type ShowcaseProviderSelection,
} from './support/llm-package-showcase-support.js';
import {
  assertScenarioResult,
  buildShowcaseScenarios,
  createShowcaseWorkspace,
  summarizeChunks,
  type ShowcaseScenario,
  type ShowcaseScenarioResult,
} from './support/llm-showcase-fixtures.js';

const MAX_ITERATIONS = 8;
const CONTROL_TOOL_NAMES = new Set(['final_answer', 'blocked']);

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

async function assertHitlStrictSchema(runtime: LLMRuntime) {
  const tools = runtime.resolveTools({
    builtIns: {
      ask_user_input: true,
    },
  });

  assert(tools.ask_user_input, 'ask_user_input should be model-visible');
  assert.equal(tools.ask_user_input.execute, undefined, 'ask_user_input should be host-owned');
  const askSchema = tools.ask_user_input.parameters as any;
  assert.equal(askSchema.required[0], 'questions');
  assert.equal(askSchema.properties.questions.type, 'array');
  assert.equal(askSchema.properties.type.enum[0], 'single-select');
  assert.equal(askSchema.properties.type.enum[1], 'multiple-select');
}

function collectToolNames(messages: LLMChatMessage[]): string[] {
  return messages.flatMap((message) => (
    message.tool_calls ?? []
  ))
    .map((toolCall) => toolCall.function.name)
    .filter((toolName) => !CONTROL_TOOL_NAMES.has(toolName));
}

function countModelTurns(messages: LLMChatMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length;
}

async function runRuntimeScenario(
  scenario: ShowcaseScenario,
  workingDirectory: string,
  providerSelection: ShowcaseProviderSelection,
  runtime: LLMRuntime,
): Promise<ShowcaseScenarioResult> {
  if (scenario.mode === 'stream') {
    const chunks: LLMStreamChunk[] = [];
    const toolNames: string[] = [];
    let finalText = '';
    let turns = 0;

    for await (const event of runtime.streamComplete({
      provider: providerSelection.provider,
      model: providerSelection.model,
      builtIns: scenario.builtIns,
      messages: [...scenario.messages],
      temperature: 0,
      context: {
        workingDirectory,
      },
      maxIterations: MAX_ITERATIONS,
    })) {
      turns = Math.max(turns, event.iteration);

      if (event.type === 'text_delta') {
        chunks.push({ content: event.delta });
      }

      if (event.type === 'reasoning_delta') {
        chunks.push({ reasoningContent: event.delta });
      }

      if (event.type === 'tool_start' && !CONTROL_TOOL_NAMES.has(event.toolCall.function.name)) {
        toolNames.push(event.toolCall.function.name);
        console.log(`  tool -> ${event.toolCall.function.name}(${event.toolCall.function.arguments || '{}'})`);
      }

      if (event.type === 'completed') {
        finalText = event.result.output ?? '';
      }

      if (event.type === 'tool_calls') {
        throw new Error(`Scenario returned host-handled tool calls: ${(event.result.toolCalls ?? []).map((toolCall) => toolCall.function.name).join(', ')}`);
      }

      if (event.type === 'failed') {
        throw new Error(event.result.error ?? 'Runtime stream completion failed.');
      }
    }

    if (!finalText) {
      throw new Error(`Scenario "${scenario.name}" finished without a final answer.`);
    }

    if (!chunks.length) {
      chunks.push({ content: finalText });
    }

    return {
      finalText,
      toolNames,
      chunks,
      turns,
    };
  }

  const result = await runtime.complete({
    provider: providerSelection.provider,
    model: providerSelection.model,
    builtIns: scenario.builtIns,
    messages: [...scenario.messages],
    temperature: 0,
    context: {
      workingDirectory,
    },
    maxIterations: MAX_ITERATIONS,
  });

  if (result.status === 'tool_calls') {
    throw new Error(`Scenario returned host-handled tool calls: ${(result.toolCalls ?? []).map((toolCall) => toolCall.function.name).join(', ')}`);
  }

  if (result.status !== 'completed') {
    throw new Error(result.error ?? `Scenario ended with status ${result.status}.`);
  }

  const toolNames = collectToolNames(result.messages);
  for (const toolName of toolNames) {
    console.log(`  tool -> ${toolName}`);
  }

  return {
    finalText: result.output ?? '',
    toolNames,
    chunks: [],
    turns: countModelTurns(result.messages),
  };
}

async function runShowcaseWithSelection(providerSelection: ShowcaseProviderSelection, dryRun: boolean) {
  const workspace = await createShowcaseWorkspace();
  const environment = createRuntime({
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
    shell_cmd: false,
    web_fetch: false,
    write_file: false,
    list_files: false,
    search_files: false,
    create_directory: false,
    path_exists: false,
  };

  try {
    console.log('LLM package real showcase');
    console.log(`provider=${providerSelection.provider}`);
    console.log(`model=${providerSelection.model}`);

    const resolvedTools = {
      ...environment.resolveTools({ builtIns: showcaseBuiltIns }),
      ...await environment.mcpRegistry.resolveTools(),
    };
    console.log(`tools=${Object.keys(resolvedTools).join(', ')}`);
    await assertHitlStrictSchema(environment);
    console.log('hitl-strict-schema=ok');

    if (dryRun) {
      console.log('dry-run=ok');
      return;
    }

    for (const scenario of buildShowcaseScenarios()) {
      console.log(`\n[scenario] ${scenario.name}`);
      const result = await runRuntimeScenario(
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
    await environment.dispose().catch(() => undefined);
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
