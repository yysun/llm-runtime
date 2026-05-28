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
  const finalAnswerCall = toolCall('final-resume-e2e-1', 'final_answer', {
    answer: 'resumed after host tool result',
  });
  const { runtime, server } = await createLocalRuntime([
    chatToolResponse([askCall]),
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
        content: JSON.stringify({ answers: { scope: 'all' } }),
      },
    ];
    const second = await runtime.complete({
      provider: 'openai-compatible',
      model: 'host-owned-e2e',
      messages: resumedMessages,
    });

    assert.equal(second.status, 'completed');
    assert.equal(second.output, 'resumed after host tool result');
    assert.equal(server.recordedRequests.length, 2);
    assert(server.recordedRequests[1]?.body.messages.some((message: any) => (
      message.role === 'tool'
      && message.tool_call_id === askCall.id
      && message.content === JSON.stringify({ answers: { scope: 'all' } })
    )));
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
  console.log('host-owned-tool-calls status: PASS');
}

main().catch((error) => {
  console.error('host-owned-tool-calls status: FAIL');
  console.error(error);
  process.exitCode = 1;
});
