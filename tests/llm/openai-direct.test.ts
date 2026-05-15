/**
 * LLM Package OpenAI Provider Tests
 *
 * Purpose:
 * - Validate the package-owned OpenAI-compatible provider helpers without real SDK traffic.
 *
 * Key features:
 * - Covers non-streaming response normalization for tool calls and usage.
 * - Covers streaming chunk forwarding for text, reasoning content, and tool calls.
 *
 * Implementation notes:
 * - Uses fake client objects instead of real network calls.
 * - Exercises the provider module through its public exports.
 *
 * Recent changes:
 * - 2026-03-27: Initial targeted OpenAI-compatible provider coverage for `llm-runtime`.
 */

import { describe, expect, it } from 'vitest';
import {
  generateOpenAIResponse,
  streamOpenAIResponse,
} from '../../src/openai-direct.js';

describe('llm-runtime openai-direct', () => {
  it('sanitizes provider-facing tool names and maps responses back to runtime tool names', async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const runtimeToolName = 'demo.server_lookup.tool.with.invalid.characters.and.a.very.long.suffix.that.must.be.shortened.for.openai';
    const fakeClient = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            capturedRequest = request;
            const providerToolName = ((request.tools as Array<{ function: { name: string } }>)?.[0]?.function.name) ?? '';
            return {
              choices: [
                {
                  message: {
                    content: 'Need normalized MCP tool',
                    tool_calls: [
                      {
                        id: 'tool-call-normalized-1',
                        type: 'function',
                        function: {
                          name: providerToolName,
                          arguments: '{"query":"hello"}',
                        },
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      },
    } as any;

    const response = await generateOpenAIResponse({
      client: fakeClient,
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Call the MCP lookup tool',
        },
      ],
      tools: {
        [runtimeToolName]: {
          name: runtimeToolName,
          description: 'Lookup tool',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    });

    const providerToolName = ((capturedRequest?.tools as Array<{ function: { name: string } }>)?.[0]?.function.name) ?? '';
    expect(providerToolName).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(providerToolName.length).toBeLessThanOrEqual(64);
    expect(response.tool_calls?.[0]?.function.name).toBe(runtimeToolName);
    expect(response.assistantMessage.tool_calls?.[0]?.function.name).toBe(runtimeToolName);
  });

  it('serializes reasoning effort using the chat-completions reasoning_effort field', async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const fakeClient = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            capturedRequest = request;
            return {
              choices: [
                {
                  message: {
                    content: 'reasoning enabled',
                  },
                },
              ],
            };
          },
        },
      },
    } as any;

    await generateOpenAIResponse({
      client: fakeClient,
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Think carefully',
        },
      ],
      reasoningEffort: 'medium',
    });

    expect(capturedRequest).toEqual(expect.objectContaining({
      reasoning_effort: 'medium',
    }));
    expect(capturedRequest).not.toHaveProperty('reasoning');
  });

  it('passes chat-completions web search options through to OpenAI', async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const fakeClient = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            capturedRequest = request;
            return {
              choices: [
                {
                  message: {
                    content: 'web search enabled',
                  },
                },
              ],
            };
          },
        },
      },
    } as any;

    await generateOpenAIResponse({
      client: fakeClient,
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Search the web',
        },
      ],
      webSearch: {
        searchContextSize: 'high',
      },
    });

    expect(capturedRequest).toEqual(expect.objectContaining({
      web_search_options: {
        search_context_size: 'high',
      },
    }));
  });

  it('ignores web search for Azure OpenAI chat-completions requests', async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const fakeClient = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            capturedRequest = request;
            return {
              choices: [
                {
                  message: {
                    content: 'azure web search enabled',
                  },
                },
              ],
            };
          },
        },
      },
    } as any;

    const response = await generateOpenAIResponse({
      client: fakeClient,
      provider: 'azure',
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Search the web',
        },
      ],
      webSearch: {
        searchContextSize: 'medium',
      },
    });

    expect(capturedRequest).not.toHaveProperty('web_search_options');
    expect(response.warnings).toEqual([
      expect.objectContaining({
        code: 'web_search_ignored',
        provider: 'azure',
      }),
    ]);
  });

  it('normalizes non-streaming tool calls into package-native responses', async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: 'Need a tool',
                  tool_calls: [
                    {
                      id: 'tool-call-1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"filePath":"README.md"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
        },
      },
    } as any;

    const response = await generateOpenAIResponse({
      client: fakeClient,
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Read the file',
        },
      ],
      tools: {
        read_file: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      },
      reasoningEffort: 'low',
    });

    expect(response).toEqual({
      type: 'tool_calls',
      content: 'Need a tool',
      tool_calls: [
        {
          id: 'tool-call-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"filePath":"README.md"}',
          },
        },
      ],
      assistantMessage: {
        role: 'assistant',
        content: 'Need a tool',
        tool_calls: [
          {
            id: 'tool-call-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"filePath":"README.md"}',
            },
          },
        ],
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
  });

  it('streams content, reasoning, and tool calls into a package-native response', async () => {
    async function* createStream() {
      yield {
        choices: [
          {
            delta: {
              reasoning: 'think-1',
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              content: 'hello ',
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'tool-stream-1',
                  function: {
                    name: 'read_file',
                    arguments: '{"filePath":"README',
                  },
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: '.md"}',
                  },
                },
              ],
            },
          },
        ],
      };
    }

    const fakeClient = {
      chat: {
        completions: {
          create: async () => createStream(),
        },
      },
    } as any;

    const chunks: Array<{ content?: string; reasoningContent?: string }> = [];
    const response = await streamOpenAIResponse({
      client: fakeClient,
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Stream a result',
        },
      ],
      tools: {
        read_file: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      },
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      { reasoningContent: 'think-1' },
      { content: 'hello ' },
    ]);
    expect(response).toEqual({
      type: 'tool_calls',
      content: 'hello ',
      tool_calls: [
        {
          id: 'tool-stream-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"filePath":"README.md"}',
          },
        },
      ],
      assistantMessage: {
        role: 'assistant',
        content: 'hello ',
        tool_calls: [
          {
            id: 'tool-stream-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"filePath":"README.md"}',
            },
          },
        ],
      },
    });
  });

  it('serializes streaming reasoning effort using reasoning_effort', async () => {
    let capturedRequest: Record<string, unknown> | undefined;

    async function* createStream() {
      yield {
        choices: [
          {
            delta: {
              content: 'hello',
            },
          },
        ],
      };
    }

    const fakeClient = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            capturedRequest = request;
            return createStream();
          },
        },
      },
    } as any;

    await streamOpenAIResponse({
      client: fakeClient,
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Stream a result',
        },
      ],
      reasoningEffort: 'high',
      onChunk: () => undefined,
    });

    expect(capturedRequest).toEqual(expect.objectContaining({
      reasoning_effort: 'high',
    }));
    expect(capturedRequest).not.toHaveProperty('reasoning');
  });

  it('emits an early warning chunk when streaming ignores web search for Azure', async () => {
    async function* createStream() {
      yield {
        choices: [
          {
            delta: {
              content: 'hello',
            },
          },
        ],
      };
    }

    const fakeClient = {
      chat: {
        completions: {
          create: async () => createStream(),
        },
      },
    } as any;

    const chunks: Array<{ content?: string; reasoningContent?: string; warnings?: unknown[] }> = [];
    const response = await streamOpenAIResponse({
      client: fakeClient,
      provider: 'azure',
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Stream and search the web',
        },
      ],
      webSearch: true,
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      {
        warnings: [
          expect.objectContaining({
            code: 'web_search_ignored',
            provider: 'azure',
          }),
        ],
      },
      { content: 'hello' },
    ]);
    expect(response.warnings).toEqual([
      expect.objectContaining({
        code: 'web_search_ignored',
        provider: 'azure',
      }),
    ]);
  });

  it('does not emit warning chunks when OpenAI-family streaming fails before the stream starts', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const fakeClient = {
      chat: {
        completions: {
          create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
            if (options?.signal?.aborted) {
              throw new DOMException('OpenAI stream aborted', 'AbortError');
            }
            throw new Error('Expected an aborted signal');
          },
        },
      },
    } as any;

    const chunks: Array<{ content?: string; reasoningContent?: string; warnings?: unknown[] }> = [];

    await expect(streamOpenAIResponse({
      client: fakeClient,
      provider: 'azure',
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Stream and search the web',
        },
      ],
      webSearch: true,
      abortSignal: abortController.signal,
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(chunks).toEqual([]);
  });
});
