/**
 * LLM Package Turn Loop Tests
 *
 * Purpose:
 * - Validate the host-agnostic `runTurnLoop(...)` API in `packages/llm`.
 *
 * Key features:
 * - Covers plain text terminal responses with caller-owned state.
 * - Covers package-managed model invocation through the existing per-call API.
 * - Covers iterative tool-call continuation without world/agent/chat assumptions.
 *
 * Notes on implementation:
 * - Mocks package runtime model calls to keep tests deterministic and network-free.
 * - Uses only package-owned message and response contracts.
 *
 * Summary of recent changes:
 * - 2026-03-29: Added targeted coverage for the new generic package turn loop.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGenerate, mockStream } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
  mockStream: vi.fn(),
}));

vi.mock('../../src/runtime.js', () => ({
  generate: mockGenerate,
  stream: mockStream,
}));

import { runTurnLoop } from '../../src/turn-loop.js';
import type { LLMChatMessage, LLMResponse } from '../../src/types.js';

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

describe('llm-runtime runTurnLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops on a plain text response with caller-owned state only', async () => {
    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'hello' } satisfies LLMChatMessage],
        finalText: '',
      },
      emptyTextRetryLimit: 1,
      callModel: vi.fn(async ({ messages }) => createTextResponse(`echo:${messages.at(-1)?.content}`)),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state, responseText }) => ({
        state: {
          ...state,
          finalText: responseText,
        },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.iterations).toBe(1);
    expect(result.rejectedTextRetryCount).toBe(0);
    expect(result.state).toEqual({
      messages: [{ role: 'user', content: 'hello' }],
      finalText: 'echo:hello',
    });
  });

  it('can use the package-managed generate path when modelRequest is provided', async () => {
    mockGenerate.mockResolvedValueOnce(createTextResponse('done'));

    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'summarize this' } satisfies LLMChatMessage],
        seenTexts: [] as string[],
      },
      emptyTextRetryLimit: 0,
      modelRequest: {
        provider: 'openai',
        model: 'gpt-5',
      },
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state, responseText }) => ({
        state: {
          ...state,
          seenTexts: [...state.seenTexts, responseText],
        },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'summarize this' }],
    }));
    expect(result.state.seenTexts).toEqual(['done']);
  });

  it('does not finalize intent-only narration as a successful direct-turn response when action evidence is required', async () => {
    const onTextResponse = vi.fn();
    const onRejectedTextResponse = vi.fn(async ({ state, classification, responseText }) => ({
      state: {
        ...state,
        rejected: { classification, responseText },
      },
    }));

    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => createTextResponse('I will run the command now.')),
      buildMessages: async ({ state }) => state.messages,
      requiresActionEvidence: () => true,
      onTextResponse,
      onRejectedTextResponse,
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(onTextResponse).not.toHaveBeenCalled();
    expect(onRejectedTextResponse).toHaveBeenCalledWith(expect.objectContaining({
      classification: 'intent_only_narration',
      responseText: 'I will run the command now.',
    }));
    expect(result.state).toMatchObject({
      rejected: {
        classification: 'intent_only_narration',
        responseText: 'I will run the command now.',
      },
    });
  });

  it('continues after a synthesized plain-text tool intent and stops on the follow-up text', async () => {
    const responses: LLMResponse[] = [
      createTextResponse('Calling tool: read_file'),
      createTextResponse('File read successfully.'),
    ];

    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect file' } satisfies LLMChatMessage],
        toolRuns: 0,
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      callModel: vi.fn(async () => responses.shift() ?? createTextResponse('unexpected')),
      buildMessages: async ({ state, transientInstruction }) => {
        if (!transientInstruction) {
          return state.messages;
        }
        return [...state.messages, { role: 'system', content: transientInstruction }];
      },
      parsePlainTextToolIntent: (content) => {
        if (content.trim() !== 'Calling tool: read_file') {
          return null;
        }
        return {
          toolName: 'read_file',
          toolArgs: { filePath: 'notes.txt' },
        };
      },
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          toolRuns: state.toolRuns + 1,
          messages: [
            ...state.messages,
            response.assistantMessage,
            {
              role: 'tool',
              tool_call_id: response.tool_calls?.[0]?.id,
              content: 'contents',
            },
          ],
        },
        next: {
          control: 'continue',
          transientInstruction: 'Use the tool result and answer normally.',
        },
      }),
      onTextResponse: async ({ state, responseText }) => ({
        state: {
          ...state,
          finalText: responseText,
        },
      }),
    });

    expect(result.iterations).toBe(2);
    expect(result.reason).toBe('text_response');
    expect(result.state.toolRuns).toBe(1);
    expect(result.state.finalText).toBe('File read successfully.');
    expect(result.state.messages).toHaveLength(3);
    expect(result.state.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{
        function: {
          name: 'read_file',
        },
      }],
    });
  });

  it('does not finalize continuation narration as success when further action evidence is still required', async () => {
    const responses: LLMResponse[] = [
      {
        type: 'tool_calls',
        content: '',
        tool_calls: [{
          id: 'tool-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ filePath: 'notes.txt' }),
          },
        }],
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ filePath: 'notes.txt' }),
            },
          }],
        },
      },
      createTextResponse('I will inspect the file next.'),
    ];
    const onTextResponse = vi.fn();

    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'read the file and inspect it' } satisfies LLMChatMessage],
        needsMoreAction: true,
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => responses.shift() ?? createTextResponse('unexpected')),
      buildMessages: async ({ state, transientInstruction }) => {
        if (!transientInstruction) {
          return state.messages;
        }
        return [...state.messages, { role: 'system', content: transientInstruction }];
      },
      requiresActionEvidence: ({ state }) => state.needsMoreAction,
      onTextResponse,
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: {
          ...state,
          rejected: { classification, responseText },
        },
      }),
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            {
              role: 'tool',
              tool_call_id: response.tool_calls?.[0]?.id,
              content: '{"ok":true,"summary":"read complete"}',
            },
          ],
        },
        next: {
          control: 'continue',
          transientInstruction: 'Continue only when you have a verified result or a real tool call.',
        },
      }),
    });

    expect(result.iterations).toBe(2);
    expect(result.reason).toBe('rejected_text_response');
    expect(onTextResponse).not.toHaveBeenCalled();
    expect(result.state).toMatchObject({
      rejected: {
        classification: 'intent_only_narration',
        responseText: 'I will inspect the file next.',
      },
    });
  });
});
