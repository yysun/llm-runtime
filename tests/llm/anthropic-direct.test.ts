/**
 * LLM Package Anthropic Provider Tests
 *
 * Purpose:
 * - Validate the package-owned Anthropic provider helper request mapping without real SDK traffic.
 *
 * Recent changes:
 * - 2026-05-15: Added provider-safe tool-name translation and reverse-mapping coverage.
 */

import { describe, expect, it } from 'vitest';
import { generateAnthropicResponse, streamAnthropicResponse } from '../../src/anthropic-direct.js';

describe('llm-runtime anthropic-direct', () => {
  it('sanitizes Anthropic tool names and maps tool uses back to runtime names', async () => {
    let capturedRequest: Record<string, any> | undefined;
    const runtimeToolName = 'demo.server.lookup.tool.with.invalid.characters.and.a.very.long.suffix.that.must.be.shortened.for.anthropic';

    const fakeClient = {
      messages: {
        create: async (request: Record<string, any>) => {
          capturedRequest = request;
          const providerToolName = request.tools[0].name;
          return {
            content: [
              {
                id: 'anthropic-tool-1',
                input: { query: 'hello' },
                name: providerToolName,
                type: 'tool_use',
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          };
        },
      },
    } as any;

    const response = await generateAnthropicResponse({
      client: fakeClient,
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'Replay and call the tool' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'previous-tool-1',
            type: 'function',
            function: { name: runtimeToolName, arguments: JSON.stringify({ query: 'previous' }) },
          }],
        },
        { role: 'tool', tool_call_id: 'previous-tool-1', content: 'previous result' },
      ],
      tools: {
        [runtimeToolName]: {
          name: runtimeToolName,
          description: 'Lookup tool',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    });

    const providerToolName = capturedRequest?.tools?.[0]?.name ?? '';
    expect(providerToolName).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(providerToolName.length).toBeLessThanOrEqual(64);
    const replayedAssistant = capturedRequest?.messages?.find((message: any) => message.role === 'assistant');
    expect(replayedAssistant?.content).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        name: providerToolName,
      }),
    ]);
    expect(response.tool_calls?.[0]?.function.name).toBe(runtimeToolName);
    expect(response.assistantMessage.tool_calls?.[0]?.function.name).toBe(runtimeToolName);
  });

  it('adds Anthropic web search when webSearch is enabled', async () => {
    let capturedRequest: Record<string, unknown> | undefined;

    const fakeClient = {
      messages: {
        create: async (request: Record<string, unknown>) => {
          capturedRequest = request;
          return {
            content: [
              {
                type: 'text',
                text: 'anthropic web search enabled',
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          };
        },
      },
    } as any;

    await generateAnthropicResponse({
      client: fakeClient,
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: 'Search the web',
        },
      ],
      webSearch: true as any,
    });

    expect(capturedRequest).toEqual(expect.objectContaining({
      tools: [
        {
          name: 'web_search',
          type: 'web_search_20250305',
        },
      ],
    }));
  });

  it('merges Anthropic web search with client tools', async () => {
    let capturedRequest: Record<string, unknown> | undefined;

    const fakeClient = {
      messages: {
        create: async (request: Record<string, unknown>) => {
          capturedRequest = request;
          return {
            content: [
              {
                type: 'text',
                text: 'anthropic tools enabled',
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          };
        },
      },
    } as any;

    await generateAnthropicResponse({
      client: fakeClient,
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: 'Search the web and call a tool',
        },
      ],
      tools: {
        lookup: {
          name: 'lookup',
          description: 'Look something up',
          parameters: { type: 'object', properties: {} },
        },
      },
      webSearch: true as any,
    });

    expect(capturedRequest).toEqual(expect.objectContaining({
      tools: [
        expect.objectContaining({
          name: 'lookup',
        }),
        {
          name: 'web_search',
          type: 'web_search_20250305',
        },
      ],
    }));
  });

  it('does not surface Anthropic server web-search blocks as host tool calls', async () => {
    const response = await generateAnthropicResponse({
      client: {
        messages: {
          create: async () => ({
            content: [
              {
                id: 'server-web-search-1',
                input: { query: 'latest TypeScript release' },
                name: 'web_search',
                type: 'server_tool_use',
              },
              {
                tool_use_id: 'server-web-search-1',
                type: 'web_search_tool_result',
                content: [
                  {
                    encrypted_content: 'opaque',
                    title: 'TypeScript release notes',
                    type: 'search_result',
                    url: 'https://example.invalid/typescript',
                  },
                ],
              },
              {
                type: 'text',
                text: 'TypeScript 5.9 is available.',
              },
            ],
            usage: {
              input_tokens: 12,
              output_tokens: 6,
            },
          }),
        },
      } as any,
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: 'Search the web',
        },
      ],
      webSearch: {},
    });

    expect(response).toEqual(expect.objectContaining({
      type: 'text',
      content: 'TypeScript 5.9 is available.',
      assistantMessage: {
        role: 'assistant',
        content: 'TypeScript 5.9 is available.',
      },
    }));
    expect(response).not.toHaveProperty('tool_calls');
  });

  it('does not convert streamed Anthropic server web-search blocks into host tool calls', async () => {
    const chunks: Array<{ content?: string }> = [];

    const response = await streamAnthropicResponse({
      client: {
        messages: {
          create: async function* () {
            yield {
              type: 'content_block_start',
              content_block: {
                id: 'server-web-search-1',
                input: { query: 'latest TypeScript release' },
                name: 'web_search',
                type: 'server_tool_use',
              },
            };
            yield {
              type: 'content_block_start',
              content_block: {
                tool_use_id: 'server-web-search-1',
                type: 'web_search_tool_result',
                content: [
                  {
                    encrypted_content: 'opaque',
                    title: 'TypeScript release notes',
                    type: 'search_result',
                    url: 'https://example.invalid/typescript',
                  },
                ],
              },
            };
            yield {
              type: 'content_block_delta',
              delta: {
                type: 'text_delta',
                text: 'TypeScript 5.9 is available.',
              },
            };
          },
        },
      } as any,
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: 'Search the web',
        },
      ],
      webSearch: {},
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([{ content: 'TypeScript 5.9 is available.' }]);
    expect(response).toEqual(expect.objectContaining({
      type: 'text',
      content: 'TypeScript 5.9 is available.',
      assistantMessage: {
        role: 'assistant',
        content: 'TypeScript 5.9 is available.',
      },
    }));
    expect(response).not.toHaveProperty('tool_calls');
  });
});