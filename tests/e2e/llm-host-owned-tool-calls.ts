/**
 * Host-Owned Tool Calls E2E
 *
 * Purpose:
 * - Lock the public runtime facade behavior for host-owned tool calls through a real provider-adapter path.
 *
 * Key features:
 * - Starts a local OpenAI-compatible chat-completions server.
 * - Exercises `createRuntime(...).complete(...)` without live provider credentials.
 * - Verifies default `ask_user_input`, custom tools without executors, and normal message-based resume.
 * - Verifies fail-closed executable approval and batch atomicity.
 *
 * Recent changes:
 * - 2026-07-28: Added explicit approval, cancellation, malformed response,
 *   atomic batch, and streaming cancellation scenarios.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { config as loadDotEnv } from 'dotenv';
import { createRuntime, type LLMChatMessage } from '../../src/index.js';
import {
  getGeminiE2EEnvHelp,
  resolveGeminiE2ESelection,
  type ProviderE2ESelection,
} from './support/llm-provider-e2e-support.js';

loadDotEnv({
  path: path.resolve(process.cwd(), '.env'),
  override: false,
  quiet: true,
});

type RecordedRequest = {
  method?: string;
  url?: string;
  body: any;
};

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

function toolCall(id: string, name: string, args: Record<string, unknown>): OpenAIToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function chatToolResponse(toolCalls: OpenAIToolCall[]) {
  return {
    id: `chatcmpl-${toolCalls[0]?.id ?? 'tool'}`,
    object: 'chat.completion',
    created: 0,
    model: 'host-owned-e2e',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls,
      },
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function startOpenAICompatibleServer(responses: unknown[]) {
  const recordedRequests: RecordedRequest[] = [];
  const pendingResponses = [...responses];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = await readJsonBody(request);
      recordedRequests.push({ method: request.method, url: request.url, body });
      const nextResponse = pendingResponses.shift();
      assert(nextResponse, 'Local provider received more requests than expected.');
      if (body.stream === true) {
        const completion = nextResponse as any;
        const choice = completion.choices?.[0];
        const toolCalls = choice?.message?.tool_calls;
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write(`data: ${JSON.stringify({
          id: completion.id,
          object: 'chat.completion.chunk',
          created: completion.created,
          model: completion.model,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              ...(Array.isArray(toolCalls) ? {
                tool_calls: toolCalls.map((toolCall: any, index: number) => ({
                  index,
                  id: toolCall.id,
                  type: 'function',
                  function: toolCall.function,
                })),
              } : {}),
              ...(typeof choice?.message?.content === 'string'
                ? { content: choice.message.content }
                : {}),
            },
            finish_reason: choice?.finish_reason ?? null,
          }],
        })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(nextResponse));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    recordedRequests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

function toolNamesFromProviderRequest(requestBody: any): string[] {
  return (requestBody.tools ?? [])
    .map((tool: any) => tool.function?.name)
    .filter((name: unknown): name is string => typeof name === 'string');
}

async function createLocalRuntime(responses: unknown[]) {
  const server = await startOpenAICompatibleServer(responses);
  const runtime = createRuntime({
    providers: {
      'openai-compatible': {
        apiKey: 'local-test-key',
        baseUrl: server.baseUrl,
      },
    },
  });

  return { runtime, server };
}

async function assertDefaultAskUserInputStopsForHost() {
  const askCall = toolCall('ask-host-e2e-1', 'ask_user_input', {
    questions: [{
      header: 'Scope',
      id: 'scope',
      question: 'Which scope?',
      options: [
        { id: 'all', label: 'All' },
        { id: 'one', label: 'One' },
      ],
    }],
  });
  const { runtime, server } = await createLocalRuntime([
    chatToolResponse([askCall]),
  ]);

  try {
    const result = await runtime.complete({
      provider: 'openai-compatible',
      model: 'host-owned-e2e',
      messages: [{ role: 'user', content: 'Ask me for scope.' }],
    });

    assert.equal(result.status, 'tool_calls');
    assert.deepEqual(result.toolCalls, [askCall]);
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, 0);
    assert(toolNamesFromProviderRequest(server.recordedRequests[0]?.body).includes('ask_user_input'));
  } finally {
    await runtime.dispose().catch(() => undefined);
    await server.close();
  }
}

async function assertCustomToolWithoutExecutorStopsForHost() {
  const hostCall = toolCall('host-custom-e2e-1', 'host_lookup', {
    query: 'token',
  });
  const { runtime, server } = await createLocalRuntime([
    chatToolResponse([hostCall]),
  ]);

  try {
    const result = await runtime.complete({
      provider: 'openai-compatible',
      model: 'host-owned-e2e',
      messages: [{ role: 'user', content: 'Lookup token.' }],
      extraTools: [{
        name: 'host_lookup',
        description: 'Host-owned lookup.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      }],
    });

    assert.equal(result.status, 'tool_calls');
    assert.deepEqual(result.toolCalls, [hostCall]);
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, 0);
    assert(toolNamesFromProviderRequest(server.recordedRequests[0]?.body).includes('host_lookup'));
  } finally {
    await runtime.dispose().catch(() => undefined);
    await server.close();
  }
}

async function assertHostResumeUsesNormalToolMessage() {
  const askCall = toolCall('ask-resume-e2e-1', 'ask_user_input', {
    questions: [{
      header: 'Scope',
      id: 'scope',
      question: 'Which scope?',
      options: [
        { id: 'all', label: 'All' },
        { id: 'one', label: 'One' },
      ],
    }],
  });
  const recordScopeCall = toolCall('record-scope-e2e-1', 'record_scope', {
    scope: 'all',
  });
  const finalAnswerCall = toolCall('final-resume-e2e-1', 'final_answer', {
    answer: 'resumed after host tool result',
  });
  const { runtime, server } = await createLocalRuntime([
    chatToolResponse([askCall]),
    chatToolResponse([recordScopeCall]),
    chatToolResponse([finalAnswerCall]),
  ]);

  try {
    const first = await runtime.complete({
      provider: 'openai-compatible',
      model: 'host-owned-e2e',
      messages: [{ role: 'user', content: 'Ask then finish.' }],
    });
    assert.equal(first.status, 'tool_calls');
    assert.equal(first.toolCalls?.[0]?.id, askCall.id);

    const resumedMessages: LLMChatMessage[] = [
      ...first.messages,
      {
        role: 'tool',
        tool_call_id: askCall.id,
        content: JSON.stringify({
          status: 'answered',
          answers: { scope: 'all' },
        }),
      },
    ];
    const second = await runtime.complete({
      provider: 'openai-compatible',
      model: 'host-owned-e2e',
      messages: resumedMessages,
      extraTools: [{
        name: 'record_scope',
        description: 'Record the selected scope.',
        parameters: { type: 'object' },
        execute: async ({ scope }) => ({ recorded: scope }),
      }],
    });

    assert.equal(second.status, 'completed');
    assert.equal(second.output, 'resumed after host tool result');
    assert.equal(server.recordedRequests.length, 3);
    assert(server.recordedRequests[1]?.body.messages.some((message: any) => (
      message.role === 'tool'
      && message.tool_call_id === askCall.id
      && message.content === JSON.stringify({
        status: 'answered',
        answers: { scope: 'all' },
      })
    )));
  } finally {
    await runtime.dispose().catch(() => undefined);
    await server.close();
  }
}

async function assertExplicitApprovalCompletes() {
  const mutationCall = toolCall('approval-e2e-1', 'mutate_project', {
    target: 'config',
  });
  const finalAnswerCall = toolCall('approval-e2e-final-1', 'final_answer', {
    answer: 'approved mutation complete',
  });
  const { runtime, server } = await createLocalRuntime([
    chatToolResponse([mutationCall]),
    chatToolResponse([finalAnswerCall]),
  ]);
  const execute = async () => ({ ok: true });

  try {
    const result = await runtime.complete({
      provider: 'openai-compatible',
      model: 'host-owned-e2e',
      messages: [{ role: 'user', content: 'Mutate the project.' }],
      onToolApproval: () => ({ decision: 'approve' }),
      extraTools: [{
        name: 'mutate_project',
        description: 'Mutate project.',
        parameters: { type: 'object' },
        execute,
      }],
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'approved mutation complete');
    assert.equal(server.recordedRequests.length, 2);
    assert(server.recordedRequests[1]?.body.messages.some((message: any) => (
      message.role === 'tool'
      && message.tool_call_id === mutationCall.id
      && message.content === JSON.stringify({ ok: true })
    )));
  } finally {
    await runtime.dispose().catch(() => undefined);
    await server.close();
  }
}

async function assertApprovalCancellationStops() {
  const cases = [{
    name: 'explicit',
    response: { decision: 'cancel', reason: 'rejected' },
    expectedReason: 'approval_rejected',
  }, {
    name: 'legacy-boolean',
    response: true,
    expectedReason: 'approval_invalid',
  }, {
    name: 'legacy-object',
    response: { approved: true },
    expectedReason: 'approval_invalid',
  }] as const;

  for (const testCase of cases) {
    const mutationCall = toolCall(`approval-${testCase.name}-e2e-1`, 'mutate_project', {
      target: 'config',
    });
    const { runtime, server } = await createLocalRuntime([
      chatToolResponse([mutationCall]),
    ]);
    let executionCount = 0;

    try {
      const result = await runtime.complete({
        provider: 'openai-compatible',
        model: 'host-owned-e2e',
        messages: [{ role: 'user', content: 'Mutate the project.' }],
        onToolApproval: (() => testCase.response) as any,
        extraTools: [{
          name: 'mutate_project',
          description: 'Mutate project.',
          parameters: { type: 'object' },
          execute: async () => {
            executionCount += 1;
            return { ok: true };
          },
        }],
      });

      assert.equal(result.status, 'cancelled');
      assert.equal(result.cancellation?.reason, testCase.expectedReason);
      assert.equal(executionCount, 0);
      assert.equal(server.recordedRequests.length, 1);
    } finally {
      await runtime.dispose().catch(() => undefined);
      await server.close();
    }
  }
}

async function assertApprovalBatchCancellationIsAtomic() {
  const firstCall = toolCall('approval-batch-first-e2e-1', 'first_mutation', {
    step: 1,
  });
  const secondCall = toolCall('approval-batch-second-e2e-1', 'second_mutation', {
    step: 2,
  });
  const { runtime, server } = await createLocalRuntime([
    chatToolResponse([firstCall, secondCall]),
  ]);
  let executionCount = 0;
  let approvalCount = 0;

  try {
    const result = await runtime.complete({
      provider: 'openai-compatible',
      model: 'host-owned-e2e',
      messages: [{ role: 'user', content: 'Run both mutations.' }],
      onToolApproval: () => {
        approvalCount += 1;
        return approvalCount === 1
          ? { decision: 'approve' }
          : { decision: 'cancel', reason: 'rejected' };
      },
      extraTools: [{
        name: 'first_mutation',
        description: 'First mutation.',
        parameters: { type: 'object' },
        execute: async () => {
          executionCount += 1;
          return { ok: true };
        },
      }, {
        name: 'second_mutation',
        description: 'Second mutation.',
        parameters: { type: 'object' },
        execute: async () => {
          executionCount += 1;
          return { ok: true };
        },
      }],
    });

    assert.equal(result.status, 'cancelled');
    assert.equal(result.cancellation?.reason, 'approval_rejected');
    assert.equal(result.cancellation?.toolCall.id, secondCall.id);
    assert.equal(approvalCount, 2);
    assert.equal(executionCount, 0);
    assert.equal(server.recordedRequests.length, 1);
  } finally {
    await runtime.dispose().catch(() => undefined);
    await server.close();
  }
}

async function assertStreamingApprovalCancellationHasOneTerminal() {
  const mutationCall = toolCall('approval-stream-e2e-1', 'mutate_project', {
    target: 'config',
  });
  const { runtime, server } = await createLocalRuntime([
    chatToolResponse([mutationCall]),
  ]);
  let executionCount = 0;
  const eventTypes: string[] = [];

  try {
    for await (const event of runtime.streamComplete({
      provider: 'openai-compatible',
      model: 'host-owned-e2e',
      messages: [{ role: 'user', content: 'Mutate the project.' }],
      onToolApproval: () => ({ decision: 'cancel', reason: 'rejected' }),
      extraTools: [{
        name: 'mutate_project',
        description: 'Mutate project.',
        parameters: { type: 'object' },
        execute: async () => {
          executionCount += 1;
          return { ok: true };
        },
      }],
    })) {
      eventTypes.push(event.type);
    }

    assert.equal(eventTypes.filter((type) => type === 'cancelled').length, 1);
    assert(!eventTypes.some((type) => (
      type === 'failed'
      || type === 'tool_start'
      || type === 'tool_result'
      || type === 'tool_error'
    )));
    assert.equal(executionCount, 0);
    assert.equal(server.recordedRequests.length, 1);
  } finally {
    await runtime.dispose().catch(() => undefined);
    await server.close();
  }
}

async function assertGeminiDefaultAskUserInputStopsForHost(selection: ProviderE2ESelection) {
  const runtime = createRuntime({
    providers: selection.providers,
  });

  try {
    const result = await runtime.complete({
      provider: selection.provider,
      model: selection.model,
      temperature: 0,
      maxIterations: 3,
      messages: [{
        role: 'system',
        content: [
          'This is a strict host-owned tool-call test.',
          'You must call ask_user_input exactly once.',
          'Use one question with id "scope", header "Scope", and two options with ids "all" and "one".',
          'Do not answer in text and do not call final_answer.',
        ].join(' '),
      }, {
        role: 'user',
        content: 'Ask me which scope to use.',
      }],
    });

    assert.equal(result.status, 'tool_calls');
    assert.equal(result.toolCalls?.[0]?.function.name, 'ask_user_input');
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, 0);
  } finally {
    await runtime.dispose().catch(() => undefined);
  }
}

async function assertGeminiCustomToolWithoutExecutorStopsForHost(selection: ProviderE2ESelection) {
  const runtime = createRuntime({
    providers: selection.providers,
  });

  try {
    const result = await runtime.complete({
      provider: selection.provider,
      model: selection.model,
      temperature: 0,
      maxIterations: 3,
      messages: [{
        role: 'system',
        content: [
          'This is a strict host-owned custom-tool test.',
          'You must call host_lookup exactly once with query "token".',
          'Do not answer in text and do not call final_answer.',
        ].join(' '),
      }, {
        role: 'user',
        content: 'Look up the token.',
      }],
      extraTools: [{
        name: 'host_lookup',
        description: 'Host-owned lookup.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      }],
    });

    assert.equal(result.status, 'tool_calls');
    assert.equal(result.toolCalls?.[0]?.function.name, 'host_lookup');
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, 0);
  } finally {
    await runtime.dispose().catch(() => undefined);
  }
}

async function assertGeminiHostResumeUsesNormalToolMessage(selection: ProviderE2ESelection) {
  const runtime = createRuntime({
    providers: selection.providers,
  });

  try {
    const initialMessages: LLMChatMessage[] = [{
      role: 'system',
      content: [
        'This is a strict host-owned resume test.',
        'If there is no tool result yet, call ask_user_input exactly once with one scope question.',
        'If there is already a tool result for ask_user_input, call final_answer with answer "resumed after host answer".',
        'Do not answer in text.',
      ].join(' '),
    }, {
      role: 'user',
      content: 'Ask for scope, then finish after I answer.',
    }];

    const first = await runtime.complete({
      provider: selection.provider,
      model: selection.model,
      temperature: 0,
      maxIterations: 3,
      messages: initialMessages,
    });
    assert.equal(first.status, 'tool_calls');
    assert.equal(first.toolCalls?.[0]?.function.name, 'ask_user_input');
    const askCallId = first.toolCalls?.[0]?.id;
    assert(askCallId);

    const second = await runtime.complete({
      provider: selection.provider,
      model: selection.model,
      temperature: 0,
      maxIterations: 3,
      messages: [
        ...first.messages,
        {
          role: 'tool',
          tool_call_id: askCallId,
          content: JSON.stringify({ answers: { scope: 'all' } }),
        },
      ],
    });

    assert.equal(second.status, 'completed');
    assert.equal(second.output, 'resumed after host answer');
  } finally {
    await runtime.dispose().catch(() => undefined);
  }
}

async function runGeminiLiveE2E() {
  const selection = resolveGeminiE2ESelection(process.env);
  if (!selection) {
    console.error('No Gemini provider configuration was found for the host-owned tool-call e2e.\n');
    console.error(getGeminiE2EEnvHelp());
    process.exitCode = 1;
    return;
  }

  console.log('Host-owned tool calls Gemini E2E');
  console.log(`provider=${selection.provider}`);
  console.log(`model=${selection.model}`);
  await assertGeminiDefaultAskUserInputStopsForHost(selection);
  console.log('gemini-default-ask-user-input=ok');
  await assertGeminiCustomToolWithoutExecutorStopsForHost(selection);
  console.log('gemini-custom-tool-without-executor=ok');
  await assertGeminiHostResumeUsesNormalToolMessage(selection);
  console.log('gemini-message-resume=ok');
  console.log('host-owned-tool-calls gemini status: PASS');
}

async function main() {
  if (process.argv.slice(2).includes('--gemini')) {
    await runGeminiLiveE2E();
    return;
  }

  console.log('Host-owned tool calls E2E');
  await assertDefaultAskUserInputStopsForHost();
  console.log('default-ask-user-input=ok');
  await assertCustomToolWithoutExecutorStopsForHost();
  console.log('custom-tool-without-executor=ok');
  await assertHostResumeUsesNormalToolMessage();
  console.log('message-resume=ok');
  await assertExplicitApprovalCompletes();
  console.log('explicit-approval=ok');
  await assertApprovalCancellationStops();
  console.log('approval-cancellation=ok');
  await assertApprovalBatchCancellationIsAtomic();
  console.log('approval-batch-atomicity=ok');
  await assertStreamingApprovalCancellationHasOneTerminal();
  console.log('streaming-approval-cancellation=ok');
  console.log('host-owned-tool-calls status: PASS');
}

main().catch((error) => {
  console.error('host-owned-tool-calls status: FAIL');
  console.error(error);
  process.exitCode = 1;
});
