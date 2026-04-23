import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { config as loadDotEnv } from 'dotenv';
import {
  createLLMEnvironment,
  disposeLLMEnvironment,
  generate,
  runTurnLoop,
  type LLMChatMessage,
  type LLMResponse,
} from '../../src/index.js';
import { resolveToolsAsync } from '../../src/runtime.js';
import {
  getGeminiE2EEnvHelp,
  parseProviderE2EFlags,
  printProviderE2EHelp,
  resolveGeminiE2ESelection,
} from './support/llm-provider-e2e-support.js';
import { toToolMessageContent } from './support/llm-showcase-fixtures.js';

const MAX_TOOL_TURNS = 6;

type PresentationState = {
  messages: LLMChatMessage[];
  finalText: string;
  toolNames: string[];
  loadedPresentationSkill: boolean;
  readReadme: boolean;
  readPackageJson: boolean;
};

loadDotEnv({
  path: path.resolve(process.cwd(), '.env'),
  override: false,
  quiet: true,
});

function printResponse(iteration: number, response: LLMResponse) {
  console.log(`\n[llm response ${iteration}] type=${response.type}`);

  const normalizedContent = response.content.trim();
  if (normalizedContent) {
    console.log(normalizedContent);
  } else {
    console.log('(empty assistant content)');
  }

  if (response.tool_calls?.length) {
    console.log('tool calls:');
    for (const toolCall of response.tool_calls) {
      console.log(`- ${toolCall.function.name}(${toolCall.function.arguments || '{}'})`);
    }
  }
}

function isRequestedFile(inputPath: unknown, expectedBasename: string): boolean {
  const normalized = String(inputPath ?? '').trim().replace(/\\/g, '/').toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized === expectedBasename || normalized.endsWith(`/${expectedBasename}`);
}

async function runPresentationE2E(dryRun: boolean) {
  const selection = resolveGeminiE2ESelection(process.env);
  if (!selection && !dryRun) {
    console.error('No Gemini provider configuration was found for the presentation turn-loop e2e.\n');
    console.error(getGeminiE2EEnvHelp());
    process.exitCode = 1;
    return;
  }

  const geminiSelection = selection ?? {
    provider: 'google' as const,
    model: 'dry-run-model',
    providers: {},
  };
  const skillRoot = path.resolve(process.env.HOME ?? process.cwd(), '.agent-world/skills');
  const workingDirectory = process.cwd();
  const builtIns = {
    read_file: true,
    load_skill: true,
    human_intervention_request: false,
    shell_cmd: false,
    web_fetch: false,
    write_file: false,
    list_files: false,
    grep: false,
  };
  const environment = createLLMEnvironment({
    providers: geminiSelection.providers,
    skillRoots: [skillRoot],
  });

  try {
    console.log('LLM package Gemini presentation turn-loop e2e');
    console.log(`provider=${geminiSelection.provider}`);
    console.log(`model=${geminiSelection.model}`);
    console.log(`workingDirectory=${workingDirectory}`);
    console.log(`skillRoot=${skillRoot}`);

    const tools = await resolveToolsAsync({
      environment,
      builtIns,
    });
    console.log(`tools=${Object.keys(tools).join(', ')}`);

    if (dryRun) {
      console.log('dry-run=ok');
      return;
    }

    const result = await runTurnLoop<PresentationState>({
      initialState: {
        messages: [
          {
            role: 'system',
            content: [
              'You are running a strict Gemini turn-loop e2e for llm-runtime.',
              'Before giving a final answer, you must call load_skill with skill_id presentation.',
              'You must then call read_file for README.md and package.json so the presentation is grounded in the actual project.',
              'The user explicitly wants an immediate first draft, so skip intake questions and approval checkpoints from the skill.',
              'After the required tool calls succeed, produce a concise five-slide storyboard using the exact Step 3 labels from the loaded skill.',
              'State assumptions briefly and label unsupported claims as Assumption or Evidence gap.',
              'Mention llm-runtime by name and keep the answer focused on this repository.',
            ].join(' '),
          },
          {
            role: 'user',
            content: 'create a presentation of the project.',
          },
        ],
        finalText: '',
        toolNames: [],
        loadedPresentationSkill: false,
        readReadme: false,
        readPackageJson: false,
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 2,
      maxConsecutiveToolTurns: MAX_TOOL_TURNS,
      buildMessages: async ({ state, transientInstruction }) => {
        if (!transientInstruction) {
          return state.messages;
        }

        return [...state.messages, { role: 'system', content: transientInstruction }];
      },
      callModel: async ({ messages }) => await generate({
        provider: geminiSelection.provider,
        model: geminiSelection.model,
        builtIns,
        messages,
        temperature: 0,
        environment,
        context: {
          workingDirectory,
          reasoningEffort: 'medium',
        },
      }),
      onModelResponse: ({ iteration, response }) => {
        printResponse(iteration, response);
      },
      requiresActionEvidence: ({ state }) => !state.loadedPresentationSkill || !state.readReadme || !state.readPackageJson,
      onRejectedTextResponse: async ({ state, classification, responseText }) => {
        console.log(`rejected_text=${classification}`);
        console.log(responseText);
        return { state };
      },
      onTextResponse: async ({ state, response, responseText }) => ({
        state: {
          ...state,
          messages: [...state.messages, response.assistantMessage],
          finalText: responseText,
        },
      }),
      onToolCallsResponse: async ({ state, response, iteration }) => {
        assert(iteration <= MAX_TOOL_TURNS, `Scenario exceeded ${MAX_TOOL_TURNS} tool rounds without reaching a final answer.`);

        const nextMessages = [...state.messages, response.assistantMessage];
        const nextToolNames = [...state.toolNames];
        let loadedPresentationSkill = state.loadedPresentationSkill;
        let readReadme = state.readReadme;
        let readPackageJson = state.readPackageJson;

        for (const toolCall of response.tool_calls ?? []) {
          const tool = tools[toolCall.function.name];
          assert(tool?.execute, `Missing executable tool: ${toolCall.function.name}`);

          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
          } catch (error) {
            throw new Error(`Invalid tool arguments for ${toolCall.function.name}: ${error instanceof Error ? error.message : String(error)}`);
          }

          if (toolCall.function.name === 'load_skill' && String(parsedArgs.skill_id ?? '').trim() === 'presentation') {
            loadedPresentationSkill = true;
          }

          if (toolCall.function.name === 'read_file') {
            const requestedPath = parsedArgs.filePath ?? parsedArgs.path;
            if (isRequestedFile(requestedPath, 'readme.md')) {
              readReadme = true;
            }
            if (isRequestedFile(requestedPath, 'package.json')) {
              readPackageJson = true;
            }
          }

          nextToolNames.push(toolCall.function.name);
          const toolResult = await tool.execute(parsedArgs, {
            workingDirectory,
            toolCallId: toolCall.id,
            toolPermission: 'auto',
          });

          nextMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toToolMessageContent(toolResult),
          });
        }

        return {
          state: {
            ...state,
            messages: nextMessages,
            toolNames: nextToolNames,
            loadedPresentationSkill,
            readReadme,
            readPackageJson,
          },
          next: {
            control: 'continue',
          },
        };
      },
    });

    assert(result.state.loadedPresentationSkill, 'Expected the model to load the presentation skill before answering.');
    assert(result.state.readReadme, 'Expected the model to read README.md before answering.');
    assert(result.state.readPackageJson, 'Expected the model to read package.json before answering.');
    assert.match(result.state.finalText, /Slide 1:/i);
    assert.match(result.state.finalText, /BBP Headline \(Dot\):/i);
    assert.match(result.state.finalText, /Visual Recommendation:/i);
    assert.match(result.state.finalText, /Speaker Notes \(Dashes\):/i);
    assert.match(result.state.finalText, /llm-runtime/i);

    console.log('\nfinal answer:');
    console.log(result.state.finalText);
    console.log(`\nstatus: PASS in ${result.iterations} turn(s)`);
  } finally {
    await disposeLLMEnvironment(environment).catch(() => undefined);
  }
}

async function main() {
  const flags = parseProviderE2EFlags(process.argv);
  if (flags.help) {
    printProviderE2EHelp('test:e2e:gemini:presentation', getGeminiE2EEnvHelp());
    return;
  }

  await runPresentationE2E(flags.dryRun);
}

main().catch((error) => {
  console.error('gemini presentation turn-loop e2e status: FAIL');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});