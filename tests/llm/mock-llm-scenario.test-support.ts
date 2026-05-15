/**
 * Feature: scripted mock LLM helpers for deterministic completion-loop tests.
 * Notes: captures message snapshots and replays a queued sequence of model responses.
 * Recent changes:
 * - 2026-05-15: Added the initial mock LLM scenario helper for package-managed and callback-driven turn-loop tests.
 */

import { vi } from 'vitest';

import type { LLMChatMessage, LLMResponse } from '../../src/types.js';

export type MockLLMScenarioStep =
  | LLMResponse
  | ((params: {
    messages: LLMChatMessage[];
    callCount: number;
  }) => LLMResponse | Promise<LLMResponse>);

function cloneMessages(messages: LLMChatMessage[]): LLMChatMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.tool_calls
      ? {
        tool_calls: message.tool_calls.map((toolCall) => ({
          ...toolCall,
          function: {
            ...toolCall.function,
          },
        })),
      }
      : {}),
  }));
}

function unexpectedResponse(): LLMResponse {
  return {
    type: 'text',
    content: 'unexpected',
    assistantMessage: { role: 'assistant', content: 'unexpected' },
  };
}

export function createMockLLMScenario(steps: MockLLMScenarioStep[]) {
  const queue = [...steps];
  const seenMessages: LLMChatMessage[][] = [];

  const callModel = vi.fn(async (params: { messages: LLMChatMessage[] }) => {
    const messages = cloneMessages(params.messages);
    seenMessages.push(messages);
    const callCount = seenMessages.length;
    const nextStep = queue.shift();

    if (!nextStep) {
      return unexpectedResponse();
    }

    if (typeof nextStep === 'function') {
      return await nextStep({ messages, callCount });
    }

    return nextStep;
  });

  return {
    callModel,
    seenMessages,
    pendingSteps: (): number => queue.length,
  };
}