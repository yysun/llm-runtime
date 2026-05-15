/**
 * Feature: turn-loop regression and behavior tests for generic and tool-capable runtime flows.
 * Notes: covers package defaults, narration rejection, synthetic tool intent, and stop conditions.
 * Recent changes:
 * - 2026-05-15: Added a reusable scripted mock LLM scenario helper and a Jazz Gill package-managed flow regression.
 * - 2026-05-15: Added action-evidence separation regressions for HITL tools, bound executors, custom tools, and trace metadata.
 * - 2026-05-15: Added regressions for run-scoped evidence, malformed control-tool retries, and merged loop-contract prompt injection.
 * - 2026-05-15: Added preferred `runCompletionLoop(...)` and `complete(...)` coverage.
 * - 2026-05-15: Added agent control tool coverage for deterministic final, needs-input, and blocked outcomes.
 * - 2026-05-15: Added completion-loop prompt injection, stronger retry defaults, and explicit final-classification coverage.
 * - 2026-05-15: Added package-default continuation coverage for `complete(...)` with non-English and mixed-language unresolved text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGenerate, mockStream, mockExecuteToolCall, mockExecuteToolCalls } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
  mockStream: vi.fn(),
  mockExecuteToolCall: vi.fn(),
  mockExecuteToolCalls: vi.fn(),
}));

vi.mock('../../src/runtime.js', () => ({
  generate: mockGenerate,
  stream: mockStream,
  executeToolCall: mockExecuteToolCall,
  executeToolCalls: mockExecuteToolCalls,
}));

import {
  DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION,
  DEFAULT_COMPLETION_LOOP_SYSTEM_PROMPT,
  DEFAULT_POST_INTERACTION_RECOVERY_INSTRUCTION,
  DEFAULT_NON_PROGRESSING_TEXT_RECOVERY_INSTRUCTION,
  DEFAULT_WAITING_FOR_INTERACTION_RESOLUTION_INSTRUCTION,
  runCompletionLoop,
} from '../../src/completion-loop.js';
import { complete } from '../../src/index.js';
import { createMockLLMScenario } from './mock-llm-scenario.test-support.js';
import {
  runCompletionLoop as compatibilityPathRunCompletionLoop,
  complete as compatibilityPathComplete,
} from '../../src/turn-loop.js';
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

describe('llm-runtime completion loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerate.mockReset();
    mockStream.mockReset();
    mockExecuteToolCall.mockReset();
    mockExecuteToolCalls.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops on verified text and records a step summary', async () => {
    const result = await runCompletionLoop({
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

  it('complete preserves permissive completion after an observed tool round', async () => {
    const responses = [toolCall('read_file', { filePath: 'notes.txt' }), text('完成了')];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'hello' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 1,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            { role: 'tool', tool_call_id: response.tool_calls?.[0]?.id, content: 'contents' } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.state.finalText).toBe('完成了');
  });

  it('complete accepts final text after current-run tool progress even when history is compacted', async () => {
    const responses = [toolCall('read_file', { filePath: 'notes.txt' }), text('完成了')];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'hello' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            { role: 'user', content: `Compacted summary of ${response.tool_calls?.[0]?.function.name} result.` } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'verified_final_response', requiresActionEvidence: false }),
    ]);
    expect(result.state.finalText).toBe('完成了');
  });

  it('complete ignores pre-existing tool results when enforcing default evidence', async () => {
    const result = await complete({
      initialState: {
        messages: [
          { role: 'user', content: 'previous request' } satisfies LLMChatMessage,
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'old-tool-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"filePath":"README.md"}' },
            }],
          } satisfies LLMChatMessage,
          { role: 'tool', tool_call_id: 'old-tool-1', content: 'old contents' } satisfies LLMChatMessage,
          { role: 'user', content: 'inspect the current file' } satisfies LLMChatMessage,
        ] as LLMChatMessage[],
        rejected: null as null | { classification: string; responseText: string },
      },
      rejectedTextRetryLimit: 0,
      defaultTextResponseMode: 'require_tool_result',
      callModel: vi.fn(async () => text("I'll inspect the file now.")),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'non_progressing', requiresActionEvidence: true }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'non_progressing',
      responseText: "I'll inspect the file now.",
    });
  });

  it('uses the package-managed generate path', async () => {
    mockGenerate.mockResolvedValueOnce(text('done'));

    const result = await runCompletionLoop({
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

  it('defaults complete() package-managed built-ins to include ask_user_input', async () => {
    mockGenerate.mockResolvedValueOnce(text('done'));

    await complete({
      initialState: {
        messages: [{ role: 'user', content: 'summarize this' } satisfies LLMChatMessage],
      },
      modelRequest: { provider: 'openai', model: 'gpt-5' },
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-5',
      builtIns: expect.objectContaining({
        ask_user_input: true,
        read_file: true,
        search_files: true,
      }),
    }));
  });

  it('supports explicit host classification of intent-only narration', async () => {
    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => text('I will run the command now.')),
      buildMessages: async ({ state }) => state.messages,
      requiresActionEvidence: () => true,
      classifyTextResponse: ({ responseText }) => responseText.includes('I will')
        ? 'intent_only_narration'
        : undefined,
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

  it('complete injects the package completion-loop prompt', async () => {
    const seenMessages: LLMChatMessage[][] = [];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      callModel: vi.fn(async ({ messages }) => {
        seenMessages.push(messages);
        return text('done');
      }),
      buildMessages: async ({ state }) => state.messages,
      classifyTextResponse: () => 'verified_final_response',
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('text_response');
    expect(seenMessages[0]?.[0]).toEqual({
      role: 'system',
      content: expect.stringContaining(DEFAULT_COMPLETION_LOOP_SYSTEM_PROMPT),
    });
    expect(String(seenMessages[0]?.[0]?.content ?? '').match(/<llm-runtime-loop-contract>/g)?.length ?? 0).toBe(1);
    expect(String(seenMessages[0]?.[0]?.content ?? '')).toContain('<llm-runtime-loop-contract>');
    expect(String(seenMessages[0]?.[0]?.content ?? '')).toContain('Your job is to continue until the user\'s task is complete, blocked, or requires required user input.');
    expect(String(seenMessages[0]?.[0]?.content ?? '')).toContain('Prefer action over explanation.');
    expect(String(seenMessages[0]?.[0]?.content ?? '')).toContain('Do not ask the user to disambiguate before safe discovery.');
    expect(String(seenMessages[0]?.[0]?.content ?? '')).toContain('Use ask_user_input only when:');
    expect(seenMessages[0]?.[1]).toEqual({ role: 'user', content: 'inspect the file' });
  });

  it('rejects unsupported search result claims without action evidence', async () => {
    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'find Alex Smith' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      rejectedTextRetryLimit: 0,
      defaultTextResponseMode: 'require_tool_result',
      callModel: vi.fn(async () => text('I searched records and found no exact match.')),
      buildMessages: async ({ state }) => state.messages,
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onTextResponse: async ({ state }) => ({ state }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({
        classification: 'non_progressing',
        requiresActionEvidence: true,
      }),
    ]);
    expect(result.retries).toEqual([
      expect.objectContaining({
        kind: 'rejected_text',
        decision: 'stop',
        transientInstruction: DEFAULT_NON_PROGRESSING_TEXT_RECOVERY_INSTRUCTION,
      }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'non_progressing',
      responseText: 'I searched records and found no exact match.',
    });
  });

  it('confirms the Jazz Gill follow-up flow with a scripted mock LLM on the package-managed path', async () => {
    const scenario = createMockLLMScenario([
      toolCall('ask_user_input', {
        type: 'single-select',
        questions: [{
          header: 'Entity Type',
          id: 'jazz-gill-entity-type',
          question: 'What type of record are you looking for?',
          options: [
            { id: 'contact', label: 'Contact' },
            { id: 'account', label: 'Account' },
            { id: 'not-sure', label: 'Not sure' },
          ],
        }],
      }, 'jazz-hitl-1'),
      ({ messages }) => {
        expect(messages.some((message) => message.role === 'user' && message.content === 'contact')).toBe(true);
        return text('I searched Contacts by name for Jazz Gill and found no exact match.');
      },
      ({ messages }) => {
        expect(String(messages.at(-1)?.content ?? '')).toContain(DEFAULT_POST_INTERACTION_RECOVERY_INSTRUCTION);
        return toolCall('search_records', {
          query: 'Jazz Gill',
          entityType: 'contact',
        }, 'jazz-search-1');
      },
      text('No matching contact record was found for Jazz Gill.'),
    ]);
    mockGenerate.mockImplementation(async (request: { messages: LLMChatMessage[] }) => await scenario.callModel(request));

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'find jazz gill' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
        rejected: null as null | { classification: string; responseText: string },
      },
      agentControlMode: false,
      modelRequest: {
        provider: 'openai',
        model: 'gpt-5',
        builtIns: { ask_user_input: true },
        extraTools: [{
          name: 'search_records',
          description: 'Search records by name.',
          evidenceKind: 'read',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              entityType: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        }],
      },
      buildMessages: async ({ state, transientInstruction }) => (
        transientInstruction
          ? [...state.messages, { role: 'system', content: transientInstruction } satisfies LLMChatMessage]
          : state.messages
      ),
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: response.tool_calls?.[0]?.function.name === 'ask_user_input'
            ? [
              ...state.messages,
              response.assistantMessage,
              {
                role: 'tool',
                tool_call_id: response.tool_calls?.[0]?.id,
                content: JSON.stringify({ pending: true }),
              } satisfies LLMChatMessage,
              { role: 'user', content: 'contact' } satisfies LLMChatMessage,
            ]
            : [
              ...state.messages,
              response.assistantMessage,
              {
                role: 'tool',
                tool_call_id: response.tool_calls?.[0]?.id,
                content: JSON.stringify({ matches: [] }),
              } satisfies LLMChatMessage,
            ],
        },
        next: { control: 'continue' },
      }),
      onRejectedTextResponse: async ({ state, classification, responseText, response }) => ({
        state: {
          ...state,
          messages: [...state.messages, response.assistantMessage],
          rejected: { classification, responseText },
        },
      }),
      onTextResponse: async ({ state, responseText, response }) => ({
        state: {
          ...state,
          messages: [...state.messages, response.assistantMessage],
          finalText: responseText,
        },
      }),
    });

    expect(mockGenerate).toHaveBeenCalledTimes(4);
    expect(String(scenario.seenMessages[0]?.[0]?.content ?? '')).toContain('Do not ask the user to disambiguate before safe discovery.');
    expect(result.reason).toBe('text_response');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'ask_user_input', countsAsActionEvidence: false }),
      expect.objectContaining({ toolName: 'search_records', evidenceKind: 'read', countsAsActionEvidence: true }),
    ]);
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'non_progressing' }),
      expect.objectContaining({ classification: 'verified_final_response' }),
    ]);
    expect(result.state.finalText).toBe('No matching contact record was found for Jazz Gill.');
    expect(result.state.rejected).toEqual({
      classification: 'non_progressing',
      responseText: 'I searched Contacts by name for Jazz Gill and found no exact match.',
    });
  });

  it('complete defaults emptyTextRetryLimit when the caller omits it', async () => {
    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
        finalText: '',
      },
      callModel: vi.fn(async () => text('done')),
      buildMessages: async ({ state }) => state.messages,
      classifyTextResponse: () => 'verified_final_response',
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.state.finalText).toBe('done');
  });

  it('complete merges the loop contract into an existing system message', async () => {
    const seenMessages: LLMChatMessage[][] = [];

    const result = await complete({
      initialState: {
        messages: [
          { role: 'system', content: 'Follow repo conventions.' } satisfies LLMChatMessage,
          { role: 'user', content: 'inspect the file' } satisfies LLMChatMessage,
        ],
        finalText: '',
      },
      callModel: vi.fn(async ({ messages }) => {
        seenMessages.push(messages);
        return text('done');
      }),
      buildMessages: async ({ state }) => state.messages,
      classifyTextResponse: () => 'verified_final_response',
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('text_response');
    expect(seenMessages[0]).toHaveLength(2);
    expect(String(seenMessages[0]?.[0]?.content ?? '')).toContain('Follow repo conventions.');
    expect(String(seenMessages[0]?.[0]?.content ?? '').match(/<llm-runtime-loop-contract>/g)?.length ?? 0).toBe(1);
    expect(String(seenMessages[0]?.[0]?.content ?? '')).toContain('<llm-runtime-loop-contract>');
    expect(String(seenMessages[0]?.[0]?.content ?? '')).toContain('You may stop only by:');
  });

  it.each([
    ['final_answer', {}],
    ['need_user_input', {}],
    ['blocked', {}],
  ] as const)('retries malformed %s control tool payloads with the protocol instruction', async (toolName, args) => {
    const seenInstructions: string[] = [];
    const responses = [
      toolCall(toolName, args, `malformed-${toolName}`),
      toolCall('final_answer', { answer: 'Recovered answer' }, 'control-final-recovered'),
    ];

    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'continue' } satisfies LLMChatMessage],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      agentControlMode: true,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state, transientInstruction }) => {
        if (transientInstruction) {
          seenInstructions.push(transientInstruction);
          return [...state.messages, { role: 'system', content: transientInstruction } satisfies LLMChatMessage];
        }

        return state.messages;
      },
      onToolCallsResponse: async ({ state }) => ({ state }),
      onFinalAnswerToolCall: async ({ state, controlOutput }) => ({
        state: { ...state, finalText: controlOutput.answer },
      }),
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('final_answer');
    expect(result.state.finalText).toBe('Recovered answer');
    expect(seenInstructions).toContain(DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION);
  });

  it('stops repeated malformed control tool calls through the repeated-call guard', async () => {
    const onToolCallsResponse = vi.fn(async ({ state }) => ({ state }));

    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'continue' } satisfies LLMChatMessage],
      },
      emptyTextRetryLimit: 0,
      agentControlMode: true,
      repeatedToolCallGuard: { maxConsecutiveSameBatches: 1 },
      callModel: vi.fn(async () => toolCall('final_answer', {}, 'malformed-final')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse,
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('repeated_tool_call_stopped');
    expect(result.steps.map((step) => step.branch)).toEqual(['tool_calls_continue', 'repeated_tool_call_stop']);
    expect(result.stop.repeatedToolCall).toEqual(expect.objectContaining({
      consecutiveSameBatchCount: 2,
      maxConsecutiveSameBatches: 1,
      toolNames: ['final_answer'],
    }));
    expect(onToolCallsResponse).not.toHaveBeenCalled();
  });

  it('stops changing malformed control tool calls through the max-tool-round guard', async () => {
    const responses = [
      toolCall('final_answer', { nonce: 1 }, 'malformed-final-1'),
      toolCall('need_user_input', { nonce: 2 }, 'malformed-input-2'),
    ];
    const onToolCallsResponse = vi.fn(async ({ state }) => ({ state }));

    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'continue' } satisfies LLMChatMessage],
      },
      emptyTextRetryLimit: 0,
      agentControlMode: true,
      maxConsecutiveToolTurns: 1,
      repeatedToolCallGuard: false,
      callModel: vi.fn(async () => responses.shift() ?? toolCall('blocked', { nonce: 3 }, 'malformed-blocked-3')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse,
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('max_tool_rounds_exceeded');
    expect(result.steps.map((step) => step.branch)).toEqual(['tool_calls_continue', 'max_tool_rounds_stop']);
    expect(onToolCallsResponse).not.toHaveBeenCalled();
  });

  it('complete injects agent control tools on the package model path and stops on final_answer', async () => {
    mockGenerate.mockResolvedValueOnce(toolCall('final_answer', {
      answer: 'Verified result',
      evidenceRefs: ['tool:read_file:1'],
    }, 'control-final-1'));
    const onToolCallsResponse = vi.fn(async ({ state }) => ({ state }));

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      modelRequest: {
        provider: 'openai',
        model: 'gpt-5',
        builtIns: { read_file: true },
      },
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse,
      onFinalAnswerToolCall: async ({ state, controlOutput }) => ({
        state: { ...state, finalText: controlOutput.answer },
      }),
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('final_answer');
    expect(result.controlOutput).toEqual({
      kind: 'final_answer',
      toolCallId: 'control-final-1',
      answer: 'Verified result',
      evidenceRefs: ['tool:read_file:1'],
    });
    expect(result.state.finalText).toBe('Verified result');
    expect(onToolCallsResponse).not.toHaveBeenCalled();
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
      extraTools: expect.arrayContaining([
        expect.objectContaining({ name: 'final_answer' }),
        expect.objectContaining({ name: 'need_user_input' }),
        expect.objectContaining({ name: 'blocked' }),
      ]),
    }));
  });

  it('complete passes a model-request-bound tool executor to tool callbacks', async () => {
    const extraTool = {
      name: 'project_lookup',
      description: 'Project lookup',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
    };
    const directTool = {
      name: 'direct_lookup',
      description: 'Direct lookup',
      parameters: { type: 'object', properties: {} },
    };
    mockGenerate
      .mockResolvedValueOnce(toolCall('project_lookup', { id: '42' }, 'tool-bound-1'))
      .mockResolvedValueOnce(toolCall('final_answer', { answer: 'done' }, 'control-final-bound'));
    mockExecuteToolCall.mockResolvedValueOnce('lookup result');

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'lookup project' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      modelRequest: {
        provider: 'openai',
        model: 'gpt-5',
        builtIns: false,
        extraTools: [extraTool],
        tools: {
          direct_lookup: directTool,
        },
      },
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response, toolExecutor }) => {
        const toolResult = await toolExecutor?.executeToolCall(
          response.tool_calls?.[0]!,
          { workingDirectory: '/tmp/project' },
          { errorMode: 'return-artifact' },
        );

        return {
          state: {
            ...state,
            messages: [
              ...state.messages,
              response.assistantMessage,
              { role: 'tool', tool_call_id: response.tool_calls?.[0]?.id, content: String(toolResult) } satisfies LLMChatMessage,
            ],
          },
          next: { control: 'continue' },
        };
      },
      onFinalAnswerToolCall: async ({ state, controlOutput }) => ({
        state: { ...state, finalText: controlOutput.answer },
      }),
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('final_answer');
    expect(result.state.finalText).toBe('done');
    expect(mockExecuteToolCall).toHaveBeenCalledWith(expect.objectContaining({
      builtIns: false,
      extraTools: expect.arrayContaining([
        extraTool,
        expect.objectContaining({ name: 'final_answer' }),
        expect.objectContaining({ name: 'need_user_input' }),
        expect.objectContaining({ name: 'blocked' }),
      ]),
      tools: {
        direct_lookup: directTool,
      },
      errorMode: 'return-artifact',
      context: { workingDirectory: '/tmp/project' },
      toolCall: expect.objectContaining({
        id: 'tool-bound-1',
        function: expect.objectContaining({ name: 'project_lookup' }),
      }),
    }));
  });

  it('runtime rejects post-interaction "I will proceed" narration without action evidence', async () => {
    const responses = [
      toolCall('ask_user_input', {
        questions: [{
          header: 'Search Scope',
          id: 'scope',
          question: 'Should I search Jazz Gill as a contact, an account, or both?',
          options: [
            { id: 'contact', label: 'Contact' },
            { id: 'account', label: 'Account' },
            { id: 'both', label: 'Both' },
          ],
        }],
      }, 'hitl-scope-1'),
      text("To search for Jazz Gill as a contact, I need to look it up in the CRM. Before I proceed, I will: search contacts by name. I'll proceed with the contact search now."),
      text("To search for Jazz Gill as a contact, I need to look it up in the CRM. Before I proceed, I will: search contacts by name. I'll proceed with the contact search now."),
      text("To search for Jazz Gill as a contact, I need to look it up in the CRM. Before I proceed, I will: search contacts by name. I'll proceed with the contact search now."),
    ];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'search Jazz Gill' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state }) => state.messages,
      requiresActionEvidence: () => false,
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            {
              role: 'tool',
              tool_call_id: response.tool_calls?.[0]?.id,
              content: JSON.stringify({ pending: true }),
            } satisfies LLMChatMessage,
            { role: 'user', content: 'Selected: contact' } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications.every((entry) => entry.classification === 'non_progressing')).toBe(true);
    expect(result.state.finalText).toBe('');
  });

  it('complete does not enable agent control mode when no control handler is wired', async () => {
    const responses = [
      toolCall('lookup_record', { id: '42' }, 'lookup-bound-1'),
      text('Found record 42.'),
    ];
    mockGenerate.mockImplementation(async () => responses.shift() ?? text('unexpected'));
    mockExecuteToolCall.mockResolvedValueOnce(JSON.stringify({ ok: true, id: '42' }));

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'Lookup record 42.' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      modelRequest: {
        provider: 'openai',
        model: 'gpt-5',
        builtIns: false,
        extraTools: [{
          name: 'lookup_record',
          description: 'Lookup a record.',
          evidenceKind: 'read',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
        }],
      },
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response, toolExecutor }) => {
        const toolResult = await toolExecutor?.executeToolCall(response.tool_calls?.[0]!);
        return {
          state: {
            ...state,
            messages: [
              ...state.messages,
              response.assistantMessage,
              {
                role: 'tool',
                tool_call_id: response.tool_calls?.[0]?.id,
                content: String(toolResult),
              } satisfies LLMChatMessage,
            ],
          },
          next: { control: 'continue' },
        };
      },
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.state.finalText).toBe('Found record 42.');
    expect(mockGenerate).toHaveBeenCalledWith(expect.not.objectContaining({
      extraTools: expect.arrayContaining([expect.objectContaining({ name: 'final_answer' })]),
    }));
    for (const call of mockGenerate.mock.calls) {
      const passedExtraTools = (call[0]?.extraTools ?? []) as Array<{ name: string }>;
      expect(passedExtraTools.map((tool) => tool.name)).not.toContain('final_answer');
      expect(passedExtraTools.map((tool) => tool.name)).not.toContain('need_user_input');
      expect(passedExtraTools.map((tool) => tool.name)).not.toContain('blocked');
    }
  });

  it('does not treat human-input tools as action evidence', async () => {
    const responses = [
      toolCall('ask_user_input', {
        questions: [{
          header: 'Format',
          id: 'format',
          question: 'Which format?',
          options: [{ id: 'pdf', label: 'PDF' }],
        }],
      }, 'hitl-1'),
      text('Great, I will now generate the file.'),
    ];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'Generate a report.' } satisfies LLMChatMessage] as LLMChatMessage[],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            {
              role: 'tool',
              tool_call_id: response.tool_calls?.[0]?.id,
              content: JSON.stringify({ pending: true }),
            } satisfies LLMChatMessage,
            { role: 'user', content: 'Selected: pdf' } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'ask_user_input',
        evidenceKind: 'interaction',
        countsAsActionEvidence: false,
      }),
    ]);
    expect(result.classifications).toEqual([
      expect.objectContaining({
        classification: 'non_progressing',
        requiresActionEvidence: false,
        observedInteractionProgress: true,
        observedActionEvidence: false,
      }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'non_progressing',
      responseText: 'Great, I will now generate the file.',
    });
  });

  it('does not retry plain text while an interaction request is still unanswered', async () => {
    const callModel = vi.fn(async () => {
      return callModel.mock.calls.length === 1
        ? toolCall('ask_user_input', {
          questions: [{
            header: 'Entity Type',
            id: 'entity-type',
            question: 'Which type?',
            options: [{ id: 'contact', label: 'Contact' }],
          }],
        }, 'hitl-pending-1')
        : text('What type of record are you looking for?');
    });

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'Find Jazz Gill.' } satisfies LLMChatMessage] as LLMChatMessage[],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      defaultTextResponseMode: 'require_tool_result',
      callModel,
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            {
              role: 'tool',
              tool_call_id: response.tool_calls?.[0]?.id,
              content: JSON.stringify({ pending: true }),
            } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.reason).toBe('rejected_text_response');
    expect(result.retries).toEqual([
      expect.objectContaining({
        kind: 'rejected_text',
        decision: 'stop',
        retryLimit: 0,
        transientInstruction: DEFAULT_WAITING_FOR_INTERACTION_RESOLUTION_INSTRUCTION,
      }),
    ]);
  });

  it('retries with a post-interaction instruction and then continues with a task tool', async () => {
    const responses = [
      toolCall('ask_user_input', {
        questions: [{
          header: 'Entity Type',
          id: 'entity-type',
          question: 'Which type?',
          options: [{ id: 'contact', label: 'Contact' }],
        }],
      }, 'hitl-followup-1'),
      text('I searched Contacts and did not find Jazz Gill.'),
      toolCall('lookup_record', { name: 'Jazz Gill', entityType: 'contact' }, 'lookup-continue-1'),
      text('No matching contact record was found for Jazz Gill.'),
    ];
    const callModel = vi.fn(async ({ messages }: { messages: LLMChatMessage[] }) => {
      const nextResponse = responses.shift() ?? text('unexpected');

      if (callModel.mock.calls.length === 3) {
        expect(messages.at(-1)).toEqual(expect.objectContaining({ role: 'system' }));
        expect(messages.at(-1)?.content).toContain(DEFAULT_POST_INTERACTION_RECOVERY_INSTRUCTION);
      }

      return nextResponse;
    });

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'Find Jazz Gill.' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      callModel,
      buildMessages: async ({ state, transientInstruction }) => (
        transientInstruction
          ? [...state.messages, { role: 'system', content: transientInstruction } satisfies LLMChatMessage]
          : state.messages
      ),
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: response.tool_calls?.[0]?.function.name === 'ask_user_input'
            ? [
              ...state.messages,
              response.assistantMessage,
              {
                role: 'tool',
                tool_call_id: response.tool_calls?.[0]?.id,
                content: JSON.stringify({ pending: true }),
              } satisfies LLMChatMessage,
              { role: 'user', content: 'contact' } satisfies LLMChatMessage,
            ]
            : [
              ...state.messages,
              response.assistantMessage,
              {
                role: 'tool',
                tool_call_id: response.tool_calls?.[0]?.id,
                content: JSON.stringify({ ok: true, matches: [] }),
              } satisfies LLMChatMessage,
            ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.retries).toEqual([
      expect.objectContaining({
        kind: 'rejected_text',
        decision: 'retry',
        transientInstruction: DEFAULT_POST_INTERACTION_RECOVERY_INSTRUCTION,
      }),
    ]);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'ask_user_input', countsAsActionEvidence: false }),
      expect.objectContaining({ toolName: 'lookup_record', countsAsActionEvidence: true }),
    ]);
    expect(result.state.finalText).toBe('No matching contact record was found for Jazz Gill.');
  });

  it('accepts final text after human input and later action evidence', async () => {
    const responses = [
      toolCall('ask_user_input', {
        questions: [{
          header: 'Format',
          id: 'format',
          question: 'Which format?',
          options: [{ id: 'pdf', label: 'PDF' }],
        }],
      }, 'hitl-1'),
      toolCall('write_file', {
        filePath: 'output/report.md',
        content: '# Report',
      }, 'write-1'),
      text('Done. The report has been generated.'),
    ];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'Generate a report.' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: response.tool_calls?.[0]?.function.name === 'ask_user_input'
            ? [
              ...state.messages,
              response.assistantMessage,
              {
                role: 'tool',
                tool_call_id: response.tool_calls?.[0]?.id,
                content: JSON.stringify({ pending: true }),
              } satisfies LLMChatMessage,
              { role: 'user', content: 'Selected: pdf' } satisfies LLMChatMessage,
            ]
            : [
              ...state.messages,
              response.assistantMessage,
              {
                role: 'tool',
                tool_call_id: response.tool_calls?.[0]?.id,
                content: JSON.stringify({ ok: true }),
              } satisfies LLMChatMessage,
            ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.state.finalText).toBe('Done. The report has been generated.');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'ask_user_input',
        evidenceKind: 'interaction',
        countsAsActionEvidence: false,
      }),
      expect.objectContaining({
        toolName: 'write_file',
        evidenceKind: 'write',
        countsAsActionEvidence: true,
      }),
    ]);
    expect(result.classifications).toEqual([
      expect.objectContaining({
        classification: 'verified_final_response',
        requiresActionEvidence: false,
        observedInteractionProgress: true,
        observedActionEvidence: true,
      }),
    ]);
  });

  it('bound executors do not let ask_user_input satisfy action evidence', async () => {
    mockGenerate
      .mockResolvedValueOnce(toolCall('ask_user_input', {
        questions: [{
          header: 'Format',
          id: 'format',
          question: 'Which format?',
          options: [{ id: 'pdf', label: 'PDF' }],
        }],
      }, 'bound-hitl-1'))
      .mockResolvedValueOnce(text('I will proceed now.'));
    mockExecuteToolCall.mockResolvedValueOnce(JSON.stringify({ pending: true }));

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'Generate a report.' } satisfies LLMChatMessage] as LLMChatMessage[],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      modelRequest: {
        provider: 'openai',
        model: 'gpt-5',
        builtIns: { ask_user_input: true },
      },
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response, toolExecutor }) => {
        const toolResult = await toolExecutor?.executeToolCall(
          response.tool_calls?.[0]!,
          { workingDirectory: '/tmp/project' },
          { errorMode: 'return-artifact' },
        );

        return {
          state: {
            ...state,
            messages: [
              ...state.messages,
              response.assistantMessage,
              {
                role: 'tool',
                tool_call_id: response.tool_calls?.[0]?.id,
                content: String(toolResult),
              } satisfies LLMChatMessage,
              { role: 'user', content: 'Selected: pdf' } satisfies LLMChatMessage,
            ],
          },
          next: { control: 'continue' as const },
        };
      },
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(mockExecuteToolCall).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({
        classification: 'non_progressing',
        requiresActionEvidence: false,
        observedInteractionProgress: true,
        observedActionEvidence: false,
      }),
    ]);
  });

  it('treats custom executable tools as action evidence by default', async () => {
    const responses = [
      toolCall('lookup_record', { id: '42' }, 'lookup-1'),
      text('Found record 42.'),
    ];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'Lookup record 42.' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            {
              role: 'tool',
              tool_call_id: response.tool_calls?.[0]?.id,
              content: JSON.stringify({ ok: true, id: '42' }),
            } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'lookup_record',
        evidenceKind: 'external_action',
        countsAsActionEvidence: true,
      }),
    ]);
    expect(result.classifications).toEqual([
      expect.objectContaining({
        classification: 'verified_final_response',
        observedInteractionProgress: false,
        observedActionEvidence: true,
      }),
    ]);
    expect(result.state.finalText).toBe('Found record 42.');
  });

  it('complete rejects non-English unresolved text before any tool result under require_tool_result mode', async () => {
    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      defaultTextResponseMode: 'require_tool_result',
      callModel: vi.fn(async () => text('我现在去检查文件。')),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'non_progressing', requiresActionEvidence: true }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'non_progressing',
      responseText: '我现在去检查文件。',
    });
  });

  it('complete continues internally after non-English unresolved text without client-managed follow-up', async () => {
    const responses = [
      text('我现在去检查文件。'),
      toolCall('read_file', { filePath: 'notes.txt' }),
      text('完成了'),
    ];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      defaultTextResponseMode: 'require_tool_result',
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state, transientInstruction }) => (
        transientInstruction ? [...state.messages, { role: 'system', content: transientInstruction }] : state.messages
      ),
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            { role: 'tool', tool_call_id: response.tool_calls?.[0]?.id, content: 'contents' } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText, response }) => ({
        state: {
          ...state,
          messages: [...state.messages, response.assistantMessage],
          finalText: responseText,
        },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.retries).toEqual([
      expect.objectContaining({ kind: 'rejected_text', decision: 'retry', classification: 'non_progressing' }),
    ]);
    expect(result.state.finalText).toBe('完成了');
  });

  it('complete retries unresolved action text twice in require_tool_result mode before a tool call succeeds', async () => {
    const responses = [
      text('我先检查一下文件。'),
      text('先にファイルを確認します。'),
      toolCall('read_file', { filePath: 'notes.txt' }),
      text('completed'),
    ];

    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      defaultTextResponseMode: 'require_tool_result',
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state, transientInstruction }) => (
        transientInstruction ? [...state.messages, { role: 'system', content: transientInstruction }] : state.messages
      ),
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          messages: [
            ...state.messages,
            response.assistantMessage,
            { role: 'tool', tool_call_id: response.tool_calls?.[0]?.id, content: 'contents' } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText, response }) => ({
        state: {
          ...state,
          messages: [...state.messages, response.assistantMessage],
          finalText: responseText,
        },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.retries).toEqual([
      expect.objectContaining({ kind: 'rejected_text', decision: 'retry', retryLimit: 2 }),
      expect.objectContaining({ kind: 'rejected_text', decision: 'retry', retryLimit: 2 }),
    ]);
    expect(result.state.finalText).toBe('completed');
  });

  it('complete rejects mixed-language unresolved text before any tool result under require_tool_result mode', async () => {
    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'find contact by name Jazz Gill' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      defaultTextResponseMode: 'require_tool_result',
      callModel: vi.fn(async () => text('好的，我先 search 一下。')),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'non_progressing', requiresActionEvidence: true }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'non_progressing',
      responseText: '好的，我先 search 一下。',
    });
  });

  it('complete rejects Japanese unresolved text before any tool result under require_tool_result mode', async () => {
    const result = await complete({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      defaultTextResponseMode: 'require_tool_result',
      callModel: vi.fn(async () => text('先にファイルを確認します。')),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'non_progressing', requiresActionEvidence: true }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'non_progressing',
      responseText: '先にファイルを確認します。',
    });
  });

  it('treats bare text as protocol-invalid in agent control mode by default', async () => {
    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      agentControlMode: true,
      callModel: vi.fn(async () => text('Here is the answer.')),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onRejectedTextResponse: async ({ state, classification, responseText }) => ({
        state: { ...state, rejected: { classification, responseText } },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({
        classification: 'non_progressing',
        transientInstruction: DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION,
      }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'non_progressing',
      responseText: 'Here is the answer.',
    });
  });

  it('treats proceeding-style narration as intent-only when action evidence is still required', async () => {
    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'Search for Jazz Gill.' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => text('Proceeding with contact search now.')),
      buildMessages: async ({ state }) => state.messages,
      requiresActionEvidence: () => true,
      classifyTextResponse: ({ responseText }) => responseText.includes('Proceeding')
        ? 'intent_only_narration'
        : undefined,
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
    expect(result.state.rejected).toEqual({
      classification: 'intent_only_narration',
      responseText: 'Proceeding with contact search now.',
    });
  });

  it('rejects plan-first narration that ends by claiming tool work is proceeding', async () => {
    const responseText = [
      'To find **Jazz Gill**, I need to search the CRM using an allowed route from `process/api.yaml`.',
      '',
      'I will:',
      '',
      '1. Read `.env` to load the required workspace variables.',
      '2. Inspect `process/api.yaml` to confirm the correct search route.',
      '3. Call the narrowest valid `GET` route to search by name.',
      '',
      'Proceeding with CRM search now.',
    ].join('\n');

    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'find contact by name Jazz Gill' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => text(responseText)),
      buildMessages: async ({ state }) => state.messages,
      requiresActionEvidence: () => true,
      classifyTextResponse: ({ responseText: candidateText }) => candidateText.includes('Proceeding with CRM search now.')
        ? 'intent_only_narration'
        : undefined,
      onTextResponse: async ({ state }) => ({ state }),
      onRejectedTextResponse: async ({ state, classification, responseText: rejectedResponseText }) => ({
        state: { ...state, rejected: { classification, responseText: rejectedResponseText } },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'intent_only_narration' }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'intent_only_narration',
      responseText,
    });
  });

  it('rejects acknowledgement-prefixed narration that says it will now execute work', async () => {
    const responseText = [
      'Great - proceeding with CRM search for **Jazz Gill**.',
      '',
      'I will now execute the search and return with a summary of results.',
    ].join('\n');

    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: '1' } satisfies LLMChatMessage],
        rejected: null as null | { classification: string; responseText: string },
      },
      emptyTextRetryLimit: 0,
      rejectedTextRetryLimit: 0,
      callModel: vi.fn(async () => text(responseText)),
      buildMessages: async ({ state }) => state.messages,
      requiresActionEvidence: () => true,
      classifyTextResponse: ({ responseText: candidateText }) => candidateText.includes('I will now execute the search')
        ? 'intent_only_narration'
        : undefined,
      onTextResponse: async ({ state }) => ({ state }),
      onRejectedTextResponse: async ({ state, classification, responseText: rejectedResponseText }) => ({
        state: { ...state, rejected: { classification, responseText: rejectedResponseText } },
      }),
      onToolCallsResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('rejected_text_response');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'intent_only_narration' }),
    ]);
    expect(result.state.rejected).toEqual({
      classification: 'intent_only_narration',
      responseText,
    });
  });

  it('accepts final text through explicit classifier override after evidence exists', async () => {
    const responses = [
      toolCall('read_file', { filePath: 'notes.txt' }),
      text('Here is the verified answer.'),
    ];

    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage] as LLMChatMessage[],
        finalText: '',
        hasRequiredEvidence: false,
      },
      emptyTextRetryLimit: 0,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state }) => state.messages,
      requiresActionEvidence: () => true,
      classifyTextResponse: ({ state }) => state.hasRequiredEvidence
        ? 'verified_final_response'
        : 'non_progressing',
      onToolCallsResponse: async ({ state, response }) => ({
        state: {
          ...state,
          hasRequiredEvidence: true,
          messages: [
            ...state.messages,
            response.assistantMessage,
            { role: 'tool', tool_call_id: response.tool_calls?.[0]?.id, content: 'contents' } satisfies LLMChatMessage,
          ],
        },
        next: { control: 'continue' },
      }),
      onTextResponse: async ({ state, responseText, response }) => ({
        state: {
          ...state,
          messages: [...state.messages, response.assistantMessage],
          finalText: responseText,
        },
      }),
    });

    expect(result.reason).toBe('text_response');
    expect(result.state.finalText).toBe('Here is the verified answer.');
    expect(result.classifications).toEqual([
      expect.objectContaining({ classification: 'verified_final_response', requiresActionEvidence: true }),
    ]);
  });

  it('stops deterministically on need_user_input control tool calls', async () => {
    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'continue' } satisfies LLMChatMessage],
        missingQuestion: '',
      },
      emptyTextRetryLimit: 0,
      agentControlMode: true,
      callModel: vi.fn(async () => toolCall('need_user_input', {
        question: 'Which environment should I use?',
        reason: 'The target environment is missing.',
      }, 'control-input-1')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state }) => ({ state }),
      onNeedUserInputToolCall: async ({ state, controlOutput }) => ({
        state: { ...state, missingQuestion: controlOutput.question },
      }),
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('needs_user_input');
    expect(result.controlOutput).toEqual({
      kind: 'need_user_input',
      toolCallId: 'control-input-1',
      question: 'Which environment should I use?',
      reason: 'The target environment is missing.',
    });
    expect(result.state.missingQuestion).toBe('Which environment should I use?');
  });

  it('stops deterministically on blocked control tool calls', async () => {
    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'continue' } satisfies LLMChatMessage],
        blockReason: '',
      },
      emptyTextRetryLimit: 0,
      agentControlMode: true,
      callModel: vi.fn(async () => toolCall('blocked', {
        reason: 'Workspace permissions prevent the write.',
      }, 'control-blocked-1')),
      buildMessages: async ({ state }) => state.messages,
      onToolCallsResponse: async ({ state }) => ({ state }),
      onBlockedToolCall: async ({ state, controlOutput }) => ({
        state: { ...state, blockReason: controlOutput.reason },
      }),
      onTextResponse: async ({ state }) => ({ state }),
    });

    expect(result.reason).toBe('blocked');
    expect(result.controlOutput).toEqual({
      kind: 'blocked',
      toolCallId: 'control-blocked-1',
      reason: 'Workspace permissions prevent the write.',
    });
    expect(result.state.blockReason).toBe('Workspace permissions prevent the write.');
  });

  it('marks normalized text tool intents as synthetic and emits lifecycle hooks in order', async () => {
    const responses = [text('Calling tool: read_file'), text('File read successfully.')];
    const events: string[] = [];

    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect file' } satisfies LLMChatMessage] as LLMChatMessage[],
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
              { role: 'tool', tool_call_id: response.tool_calls?.[0]?.id, content: 'contents' } satisfies LLMChatMessage,
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

  it('still executes normal workspace tool calls in agent control mode', async () => {
    const responses = [toolCall('read_file', { filePath: 'notes.txt' }, 'tool-read-1'), text('fallback answer')];
    const onToolCallsResponse = vi.fn(async ({ state, response }) => ({
      state: {
        ...state,
        toolRuns: state.toolRuns + 1,
        messages: [
          ...state.messages,
          response.assistantMessage,
          { role: 'tool', tool_call_id: response.tool_calls?.[0]?.id, content: 'contents' } satisfies LLMChatMessage,
        ],
      },
      next: { control: 'continue' as const },
    }));

    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'inspect the file' } satisfies LLMChatMessage] as LLMChatMessage[],
        toolRuns: 0,
        finalText: '',
      },
      emptyTextRetryLimit: 0,
      agentControlMode: true,
      callModel: vi.fn(async () => responses.shift() ?? text('unexpected')),
      buildMessages: async ({ state, transientInstruction }) => (
        transientInstruction ? [...state.messages, { role: 'system', content: transientInstruction }] : state.messages
      ),
      onToolCallsResponse,
      onTextResponse: async ({ state, responseText }) => ({
        state: { ...state, finalText: responseText },
      }),
      classifyTextResponse: () => 'verified_final_response',
    });

    expect(result.reason).toBe('text_response');
    expect(result.state.toolRuns).toBe(1);
    expect(onToolCallsResponse).toHaveBeenCalledTimes(1);
  });

  it('stops on max_iterations_exceeded', async () => {
    const callModel = vi.fn(async () => text(''));

    const result = await runCompletionLoop({
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

  it('stops on tool_calls_response when the host does not request continuation after tool execution', async () => {
    const result = await runCompletionLoop({
      initialState: {
        messages: [{ role: 'user', content: 'use tools until done' } satisfies LLMChatMessage],
      },
      emptyTextRetryLimit: 0,
      callModel: vi.fn(async () => toolCall('read_file', { filePath: 'notes.txt' })),
      buildMessages: async ({ state }) => state.messages,
      onTextResponse: async ({ state }) => ({ state }),
      onToolCallsResponse: async ({ state, response }) => ({
        state: { ...state, messages: [...state.messages, response.assistantMessage] },
      }),
    });

    expect(result.reason).toBe('tool_calls_response');
    expect(result.steps).toEqual([
      expect.objectContaining({ branch: 'tool_calls_stop' }),
    ]);
  });

  it('stops on max_tool_rounds_exceeded before re-entering host execution', async () => {
    const onToolCallsResponse = vi.fn(async ({ state, response }) => ({
      state: { ...state, messages: [...state.messages, response.assistantMessage] },
      next: { control: 'continue' as const },
    }));

    const result = await runCompletionLoop({
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

    const result = await runCompletionLoop({
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
    const resultPromise = runCompletionLoop({
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

  it('keeps the compatibility import path wired to the preferred completion-loop APIs', async () => {
    expect(compatibilityPathRunCompletionLoop).toBe(runCompletionLoop);
    expect(compatibilityPathComplete).toBe(complete);
  });
});
