/**
 * LLM Package Turn Loop Hardening E2E Runner
 *
 * Purpose:
 * - Exercise the action-execution hardening behavior end-to-end with deterministic scripted model replies.
 *
 * Key features:
 * - Runs the real package `runTurnLoop(...)` implementation with real built-in tool resolution/execution.
 * - Covers intent-only narration recovery on direct and continuation paths.
 * - Covers durable validation-failure artifacts plus caller-driven self-correction.
 *
 * Implementation notes:
 * - Uses a temporary workspace and package-owned tools only; no live provider calls are made.
 * - The host-side recovery logic intentionally lives in this runner to mirror production integration.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createLLMEnvironment,
  DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION,
  DEFAULT_TOOL_VALIDATION_RECOVERY_INSTRUCTION,
  disposeLLMEnvironment,
  parseToolValidationFailureArtifact,
  runTurnLoop,
  type LLMChatMessage,
  type LLMEnvironment,
  type LLMResponse,
  type ToolValidationFailureArtifact,
  type TurnLoopTextResponseClassification,
} from '../../src/index.js';
import { resolveToolsAsync } from '../../src/runtime.js';
import {
  createShowcaseWorkspace,
  toToolMessageContent,
} from './support/llm-showcase-fixtures.js';

type HardeningState = {
  messages: LLMChatMessage[];
  finalText: string;
  toolNames: string[];
  rejectedTexts: Array<{
    classification: TurnLoopTextResponseClassification;
    responseText: string;
  }>;
  validationArtifacts: ToolValidationFailureArtifact[];
};

type HardeningScenarioResult = {
  finalText: string;
  toolNames: string[];
  rejectedTexts: HardeningState['rejectedTexts'];
  validationArtifacts: ToolValidationFailureArtifact[];
  turns: number;
};

type ScenarioContext = {
  workspaceRoot: string;
  environment: LLMEnvironment;
};

type ScriptedResponder = (params: {
  iteration: number;
  messages: LLMChatMessage[];
}) => Promise<LLMResponse> | LLMResponse;

type HardeningScenario = {
  name: string;
  messages: LLMChatMessage[];
  responder: ScriptedResponder;
  assertResult: (result: HardeningScenarioResult) => void;
};

function createTextResponse(content: string): LLMResponse {
  return {
    type: 'text',
    content,
    assistantMessage: {
      role: 'assistant',
      content,
    },
  };
}

function createToolCallResponse(name: string, args: Record<string, unknown>, id: string, content = ''): LLMResponse {
  return {
    type: 'tool_calls',
    content,
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    }],
    assistantMessage: {
      role: 'assistant',
      content,
      tool_calls: [{
        id,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      }],
    },
  };
}

async function runScenario(
  scenario: HardeningScenario,
  context: ScenarioContext,
): Promise<HardeningScenarioResult> {
  let modelIteration = 0;

  const result = await runTurnLoop<HardeningState>({
    initialState: {
      messages: [...scenario.messages],
      finalText: '',
      toolNames: [],
      rejectedTexts: [],
      validationArtifacts: [],
    } satisfies HardeningState,
    emptyTextRetryLimit: 0,
    rejectedTextRetryLimit: 1,
    buildMessages: async ({ state, transientInstruction }) => {
      if (!transientInstruction) {
        return state.messages;
      }

      return [...state.messages, { role: 'system', content: transientInstruction }];
    },
    callModel: async ({ messages }) => {
      modelIteration += 1;
      return await scenario.responder({
        iteration: modelIteration,
        messages,
      });
    },
    requiresActionEvidence: ({ state }) => state.finalText === '',
    onTextResponse: async ({ state, response, responseText }) => ({
      state: {
        ...state,
        messages: [...state.messages, response.assistantMessage],
        finalText: responseText,
      },
    }),
    onRejectedTextResponse: async ({ state, responseText, classification }) => ({
      state: {
        ...state,
        rejectedTexts: [...state.rejectedTexts, { classification, responseText }],
      },
    }),
    onToolCallsResponse: async ({ state, response }) => {
      const tools = await resolveToolsAsync({
        environment: context.environment,
        builtIns: {
          read_file: true,
          load_skill: false,
          human_intervention_request: false,
          shell_cmd: false,
          web_fetch: false,
          write_file: true,
          list_files: false,
          grep: false,
        },
      });

      const nextMessages: LLMChatMessage[] = [...state.messages, response.assistantMessage];
      const nextToolNames = [...state.toolNames];
      const nextValidationArtifacts = [...state.validationArtifacts];
      let currentTurnHadValidationArtifact = false;

      for (const toolCall of response.tool_calls ?? []) {
        const tool = tools[toolCall.function.name];
        assert(tool?.execute, `Missing executable tool: ${toolCall.function.name}`);

        const toolArgs = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
        const toolResult = await tool.execute(toolArgs, {
          workingDirectory: context.workspaceRoot,
          toolCallId: toolCall.id,
          toolPermission: 'auto',
        });

        nextToolNames.push(toolCall.function.name);

        const toolContent = toToolMessageContent(toolResult);
        const validationArtifact = parseToolValidationFailureArtifact(toolContent);
        if (validationArtifact) {
          nextValidationArtifacts.push(validationArtifact);
          currentTurnHadValidationArtifact = true;
        }

        nextMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolContent,
        });
      }

      return {
        state: {
          ...state,
          messages: nextMessages,
          toolNames: nextToolNames,
          validationArtifacts: nextValidationArtifacts,
        },
        next: {
          control: 'continue',
          transientInstruction: currentTurnHadValidationArtifact
            ? DEFAULT_TOOL_VALIDATION_RECOVERY_INSTRUCTION
            : undefined,
        },
      };
    },
  });

  return {
    finalText: result.state.finalText,
    toolNames: result.state.toolNames,
    rejectedTexts: result.state.rejectedTexts,
    validationArtifacts: result.state.validationArtifacts,
    turns: result.iterations,
  };
}

function buildHardeningScenarios(): HardeningScenario[] {
  const scenarios: HardeningScenario[] = [
    {
      name: 'Direct-turn narration is retried until a real tool call occurs',
      messages: [
        {
          role: 'user' as const,
          content: 'Read docs/repo-guide.txt and return REPO_TOKEN=<token>.',
        },
      ],
      responder: ({ iteration, messages }) => {
        if (iteration === 1) {
          return createTextResponse('I will inspect the file now.');
        }

        if (iteration === 2) {
          assert.equal(messages.at(-1)?.role, 'system');
          assert.equal(messages.at(-1)?.content, DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION);
          return createToolCallResponse('read_file', { filePath: 'docs/repo-guide.txt' }, 'hardening-direct-1');
        }

        assert.equal(messages.at(-1)?.role, 'tool');
        assert.match(String(messages.at(-1)?.content ?? ''), /alpha-repo-token/);
        return createTextResponse('REPO_TOKEN=alpha-repo-token');
      },
      assertResult: (result) => {
        assert.equal(result.turns, 3);
        assert.deepEqual(result.toolNames, ['read_file']);
        assert.equal(result.rejectedTexts.length, 1);
        assert.equal(result.rejectedTexts[0]?.classification, 'intent_only_narration');
        assert.equal(result.finalText, 'REPO_TOKEN=alpha-repo-token');
      },
    },
    {
      name: 'Validation failure produces a durable artifact and self-corrects',
      messages: [
        {
          role: 'user' as const,
          content: 'Write notes/hardening-report.txt and return WRITE_STATUS=ok.',
        },
      ],
      responder: ({ iteration, messages }) => {
        if (iteration === 1) {
          return createToolCallResponse('write_file', { filePath: 'notes/hardening-report.txt' }, 'hardening-validation-1');
        }

        if (iteration === 2) {
          assert.equal(messages.at(-1)?.role, 'system');
          assert.equal(messages.at(-1)?.content, DEFAULT_TOOL_VALIDATION_RECOVERY_INSTRUCTION);
          assert.match(String(messages.at(-2)?.content ?? ''), /tool_parameter_validation_failed/);
          return createToolCallResponse('write_file', {
            path: 'notes/hardening-report.txt',
            content: 'artifact-marker-33',
          }, 'hardening-validation-2');
        }

        assert.match(String(messages.at(-1)?.content ?? ''), /"status": "success"/);
        assert.match(String(messages.at(-1)?.content ?? ''), /artifact-marker-33|bytesWritten/);
        return createTextResponse('WRITE_STATUS=ok');
      },
      assertResult: (result) => {
        assert.equal(result.turns, 3);
        assert.deepEqual(result.toolNames, ['write_file', 'write_file']);
        assert.equal(result.validationArtifacts.length, 1);
        assert.equal(result.validationArtifacts[0]?.toolName, 'write_file');
        assert.equal(result.validationArtifacts[0]?.issues[0]?.path, 'content');
        assert.equal(result.validationArtifacts[0]?.issues[0]?.code, 'missing_required');
        assert.equal(result.finalText, 'WRITE_STATUS=ok');
      },
    },
    {
      name: 'Continuation narration is retried before accepting a verified answer',
      messages: [
        {
          role: 'user' as const,
          content: 'Read docs/repo-guide.txt and return INSPECTED_TOKEN=<token>.',
        },
      ],
      responder: ({ iteration, messages }) => {
        if (iteration === 1) {
          return createToolCallResponse('read_file', { filePath: 'docs/repo-guide.txt' }, 'hardening-continuation-1');
        }

        if (iteration === 2) {
          assert.equal(messages.at(-1)?.role, 'tool');
          assert.match(String(messages.at(-1)?.content ?? ''), /alpha-repo-token/);
          return createTextResponse('I will inspect the file next.');
        }

        assert.equal(messages.at(-1)?.role, 'system');
        assert.equal(messages.at(-1)?.content, DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION);
        return createTextResponse('INSPECTED_TOKEN=alpha-repo-token');
      },
      assertResult: (result) => {
        assert.equal(result.turns, 3);
        assert.deepEqual(result.toolNames, ['read_file']);
        assert.equal(result.rejectedTexts.length, 1);
        assert.equal(result.rejectedTexts[0]?.responseText, 'I will inspect the file next.');
        assert.equal(result.finalText, 'INSPECTED_TOKEN=alpha-repo-token');
      },
    },
  ];

  return scenarios.map((scenario) => ({
    ...scenario,
    messages: scenario.messages.map((message) => ({ ...message })),
  }));
}

async function main() {
  const workspace = await createShowcaseWorkspace();
  const environment = createLLMEnvironment({
    skillRoots: workspace.skillRoots,
  });

  try {
    console.log('LLM package turn-loop hardening e2e');

    for (const scenario of buildHardeningScenarios()) {
      console.log(`\n[scenario] ${scenario.name}`);
      const result = await runScenario(scenario, {
        workspaceRoot: workspace.rootPath,
        environment,
      });
      scenario.assertResult(result);
      console.log(`  tools used: ${result.toolNames.join(', ') || '(none)'}`);
      console.log(`  rejected texts: ${result.rejectedTexts.length}`);
      console.log(`  validation artifacts: ${result.validationArtifacts.length}`);
      console.log(`  final answer: ${result.finalText}`);
      console.log(`  status: PASS in ${result.turns} turn(s)`);
    }

    console.log('\nhardening e2e status: PASS');
  } finally {
    await disposeLLMEnvironment(environment).catch(() => undefined);
    await rm(path.dirname(workspace.rootPath), { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('hardening e2e status: FAIL');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});