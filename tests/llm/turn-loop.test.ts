import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function text(content: string): LLMResponse {
  return {
    type: 'text',
    content,
    assistantMessage: { role: 'assistant', content },
  };
}

function toolCall(name: string, args: Record<string, unknown>, id = 'tool-1'): LLMResponse {
  return {
    type: 'tool_calls',
    content: '',
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
    assistantMessage: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
  };
}

describe('llm-runtime runTurnLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops on verified text and records a step summary', async () => {
    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'hello' } satisfies LLMChatMessage],
        finalText: '',
      },
      emptyTextRetryLimit: 1,
      callModel: vi.fn(async ({ messages }) => text(`echo:${messages.at(-1)?.content}`)),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.stop.reason).toBe('text_response');
    expect(result.iterations).toBe(1);
    expect(result.steps).toEqual([
      expect.objectContaining({ iteration: 1, branch: 'text_response_stop' }),
    ]);
    expect(result.state.finalText).toBe('echo:hello');
  });

  it('uses the package-managed generate path', async () => {
    mockGenerate.mockResolvedValueOnce(text('done'));

    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'summarize this' } satisfies LLMChatMessage],
        seenTexts: [] as string[],
      },
      emptyTextRetryLimit: 0,
      modelRequest: { provider: 'openai', model: 'gpt-5' },
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, seenTexts: [...state.seenTexts, responseText] },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', model: 'gpt-5' }));
    expect(result.state.seenTexts).toEqual(['done']);
  });

  it('stops rejected narration with classification and retry history', async () => {
    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => text('I will run the command now.')),
      buildMessages: async ({ state }) => state.messages,
      requiresActionEvidence: () => true,
      onTextResponse: async ({ state }) => ({ state }),
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'intent_only_narration' }),
    ]);
    expect(result.retries).toEqual([
      expect.objectContaining({ kind: 'rejected_text', decision: 'stop' }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'intent_only_narration',
      responseText: 'I will run the command now.',
    });
  });

  it('marks normalized text tool intents as synthetic and emits lifecycle hooks in order', async () => {
    const responses = [text('Calling tool: read_file'), text('File read successfully.')];
    const events: string[] = [];

    const result = await runTurnLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect file' } satisfies LLMChatMessage],
        toolRuns: 0,
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      markSyntheticToolCalls: true,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      onIterationStart: ({ iteration }) => { events.push(`start:${iteration}`); },
      onModelResponse: ({ iteration, response, normalizedToolIntent }) => {
        events.push(`model:${iteration}:${response.type}:${normalizedToolIntent ? 'synthetic' : 'model'}`);
      },
      onClassification: ({ iteration, assessment }) => {
        events.push(`classification:${iteration}:${assessment.classification}`);
      },
      onStop: ({ result: finalResult }) => { events.push(`stop:${finalResult.reason}`); },
      buildMessages: async ({ state, transientInstruction }) => (
        transientInstruction ? [...state.messages, { role: 'system', content: transientInstruction }] : state.messages
      ),
      parsePlainTextToolIntent: (content) => content.trim() === 'Calling tool: read_file'
        ? { toolName: 'read_file', toolArgs: { filePath: 'notes.txt' } }
        : null,
      onToolCallsResponse: async ({ state, response, iteration }) => {
        events.push(`tool:${iteration}`);
        return {
          state: {
            ...state,
            toolRuns: state.toolRuns + 1,
            messages: [
              ...state.messages,
              response.assistantMessage,
              { role: 'tool', tool_call_id: response.tool_calls?.[0]?.id, content: 'contents' },
            ],
          },
          next: { control: 'continue', transientInstruction: 'Use the tool result and answer normally.' },
        };
      },
      onTextResponse: async ({ state, responseText, iteration }) => {
        events.push(`text:${iteration}`);
        return { state: { ...state, finalText: responseText } };
      },
    });

    expect(result.reason).toBe('text_response');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'read_file', source: 'normalized_text_intent', synthetic: true }),
    ]);
    expect(result.state.messages[1]).toMatchObject({
      tool_calls: [{ synthetic: true, function: { name: 'read_file' } }],
    });
    expect(events).toEqual([
      'start:1',
      'model:1:tool_calls:synthetic',
      'tool:1',
      'start:2',
      'model:2:text:model',
      'classification:2:verified_final_response',
      'text:2',
      'stop:text_response',
    ]);
  });

  it('stops on max_iterations_exceeded', async () => {
    const callModel = vi.fn(async () => text(''));

    const result = await runTurnLoop({
      initialState: { messages: [{ role: 'user', content: 'keep trying' } satisfies LLMChatMessage] },
      emptyTextRetryLimit: 5,
      maxIterations: 2,
      callModel,
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('max_iterations_exceeded');
    expect(result.iterations).toBe(2);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('stops on max_tool_rounds_exceeded before re-entering host execution', async () => {
    const onToolCallsResponse = vi.fn(async ({ state, response }) => ({
      state: { ...state, messages: [...state.messages, response.assistantMessage] },
      next: { control: 'continue' as const },
    }));

    const result = await runTurnLoop({
      initialState: { messages: [{ role: 'user', content: 'use tools until done' } satisfies LLMChatMessage] },
      emptyTextRetryLimit: 0,
      maxConsecutiveToolTurns: 1,
      callModel: vi.fn(async () => toolCall('read_file', { filePath: 'notes.txt' })),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onToolCallsResponse,
    });

    expect(result.reason).toBe('max_tool_rounds_exceeded');
    expect(result.steps.map((step) => step.branch)).toEqual(['tool_calls_continue', 'max_tool_rounds_stop']);
    expect(onToolCallsResponse).toHaveBeenCalledTimes(1);
  });

  it('stops repeated identical tool-call batches before host execution repeats', async () => {
    const repeated = toolCall('read_file', { filePath: 'notes.txt' });
    const onToolCallsResponse = vi.fn(async ({ state, response }) => ({
      state: { ...state, messages: [...state.messages, response.assistantMessage] },
      next: { control: 'continue' as const },
    }));

    const result = await runTurnLoop({
      initialState: { messages: [{ role: 'user', content: 'loop the same tool call' } satisfies LLMChatMessage] },
      emptyTextRetryLimit: 0,
      repeatedToolCallGuard: { maxConsecutiveSameBatches: 1 },
      callModel: vi.fn(async () => repeated),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onToolCallsResponse,
    });

    expect(result.reason).toBe('repeated_tool_call_stopped');
    expect(result.stop.repeatedToolCall).toEqual(expect.objectContaining({
      consecutiveSameBatchCount: 2,
      maxConsecutiveSameBatches: 1,
    }));
    expect(onToolCallsResponse).toHaveBeenCalledTimes(1);
  });

  it('stops on timeout and aborts the provided model signal', async () => {
    vi.useFakeTimers();

    let seenAbortSignal: AbortSignal | undefined;
    const resultPromise = runTurnLoop({
      initialState: { messages: [{ role: 'user', content: 'wait forever' } satisfies LLMChatMessage] },
      emptyTextRetryLimit: 0,
      maxWallTimeMs: 25,
      callModel: vi.fn(async ({ abortSignal }) => {
        seenAbortSignal = abortSignal;
        return await new Promise<LLMResponse>(() => undefined);
      }),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result.reason).toBe('timeout');
    expect(result.response).toBeNull();
    expect(result.stop).toEqual(expect.objectContaining({ reason: 'timeout', timedOutDuringIteration: 1 }));
    expect(seenAbortSignal?.aborted).toBe(true);
  });
});
