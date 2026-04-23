/**
 * LLM Package Runtime Provider Dispatch Tests
 *
 * Purpose:
 * - Verify that the per-call APIs dispatch through the package-owned provider layer.
 *
 * Key features:
 * - Covers per-call generate and stream provider dispatch.
 * - Verifies explicit-environment and per-call tool resolution reaches the provider adapter.
 * - Uses mocked package provider modules with no real SDK or network usage.
 *
 * Implementation notes:
 * - Mocks package provider modules directly to keep tests focused on runtime orchestration.
 * - Avoids real filesystem, network, and provider clients.
 *
 * Recent changes:
 * - 2026-03-27: Initial provider-dispatch coverage for the publishable `llm-runtime` runtime.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateAnthropicClient,
  mockGenerateAnthropicResponse,
  mockStreamAnthropicResponse,
  mockCreateClientForProvider,
  mockGenerateOpenAIResponse,
  mockStreamOpenAIResponse,
  mockCreateGoogleClient,
  mockGenerateGoogleResponse,
  mockStreamGoogleResponse,
} = vi.hoisted(() => ({
  mockCreateAnthropicClient: vi.fn(() => ({ client: 'anthropic' })),
  mockGenerateAnthropicResponse: vi.fn(async () => ({
    type: 'text',
    content: 'anthropic-generated',
    assistantMessage: {
      role: 'assistant',
      content: 'anthropic-generated',
    },
  })),
  mockStreamAnthropicResponse: vi.fn(async (request: any) => {
    request.onChunk({ content: 'anthropic-chunk-1' });
    return {
      type: 'text',
      content: 'anthropic-streamed',
      assistantMessage: {
        role: 'assistant',
        content: 'anthropic-streamed',
      },
    };
  }),
  mockCreateClientForProvider: vi.fn(() => ({ client: 'openai' })),
  mockGenerateOpenAIResponse: vi.fn(async (request: any) => ({
    type: 'text',
    content: 'generated',
    assistantMessage: {
      role: 'assistant',
      content: `tools:${Object.keys(request.tools || {}).join(',')}`,
    },
  })),
  mockStreamOpenAIResponse: vi.fn(async (request: any) => {
    request.onChunk({ content: 'chunk-1' });
    request.onChunk({ reasoningContent: 'reasoning-1' });
    return {
      type: 'text',
      content: 'streamed',
      assistantMessage: {
        role: 'assistant',
        content: 'streamed',
      },
    };
  }),
  mockCreateGoogleClient: vi.fn(() => ({ client: 'google' })),
  mockGenerateGoogleResponse: vi.fn(async () => ({
    type: 'text',
    content: 'google-generated',
    assistantMessage: {
      role: 'assistant',
      content: 'google-generated',
    },
  })),
  mockStreamGoogleResponse: vi.fn(async (request: any) => {
    request.onChunk({ content: 'google-chunk-1' });
    return {
      type: 'text',
      content: 'google-streamed',
      assistantMessage: {
        role: 'assistant',
        content: 'google-streamed',
      },
    };
  }),
}));

vi.mock('../../src/anthropic-direct.js', () => ({
  createAnthropicClient: mockCreateAnthropicClient,
  generateAnthropicResponse: mockGenerateAnthropicResponse,
  streamAnthropicResponse: mockStreamAnthropicResponse,
}));

vi.mock('../../src/openai-direct.js', () => ({
  createClientForProvider: mockCreateClientForProvider,
  generateOpenAIResponse: mockGenerateOpenAIResponse,
  streamOpenAIResponse: mockStreamOpenAIResponse,
}));

vi.mock('../../src/google-direct.js', () => ({
  createGoogleClient: mockCreateGoogleClient,
  generateGoogleResponse: mockGenerateGoogleResponse,
  streamGoogleResponse: mockStreamGoogleResponse,
}));

describe('llm-runtime runtime provider dispatch', () => {
  afterEach(async () => {
    const { disposeLLMRuntimeCaches } = await import('../../src/runtime.js');
    await disposeLLMRuntimeCaches();
  });

  it('dispatches generate requests through an explicit environment', async () => {
    const { createLLMEnvironment, generate } = await import('../../src/runtime.js');

    const environment = createLLMEnvironment({
      providers: {
        openai: {
          apiKey: 'test-openai-key',
        },
      },
    });

    const response = await generate({
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      context: {
        reasoningEffort: 'high',
      },
      environment,
      builtIns: false,
      extraTools: [
        {
          name: 'project_lookup',
          description: 'Project lookup',
          parameters: { type: 'object' },
        },
      ],
      tools: {
        project_write: {
          name: 'project_write',
          description: 'Project write',
          parameters: { type: 'object' },
        },
      },
    });

    expect(response.content).toBe('generated');
    expect(mockCreateClientForProvider).toHaveBeenCalledWith('openai', {
      apiKey: 'test-openai-key',
    });
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'high',
      tools: {
        project_lookup: expect.objectContaining({ name: 'project_lookup' }),
        project_write: expect.objectContaining({ name: 'project_write' }),
      },
    }));
  });

  it('dispatches stream requests through an explicit environment', async () => {
    const { createLLMEnvironment, stream } = await import('../../src/runtime.js');

    const environment = createLLMEnvironment({
      providers: {
        openai: {
          apiKey: 'test-openai-key',
        },
      },
      defaults: {
        reasoningEffort: 'medium',
      },
    });

    const chunks: Array<{ content?: string; reasoningContent?: string }> = [];
    const response = await stream({
      provider: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Stream please',
        },
      ],
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
      environment,
      builtIns: false,
    });

    expect(response.content).toBe('streamed');
    expect(chunks).toEqual([
      { content: 'chunk-1' },
      { reasoningContent: 'reasoning-1' },
    ]);
    expect(mockStreamOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'medium',
    }));
  });

  it('rejects per-call request.tools attempts to override reserved built-in names', async () => {
    const { generate } = await import('../../src/runtime.js');

    await expect(generate({
      provider: 'openai',
      providerConfig: {
        apiKey: 'test-openai-key',
      },
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      tools: {
        read_file: {
          name: 'read_file',
          description: 'override',
          parameters: { type: 'object' },
        },
      },
    })).rejects.toThrow('Tool name "read_file" is reserved by llm-runtime built-ins.');
  });

  it('dispatches per-call generate requests without constructing a runtime', async () => {
    const { generate } = await import('../../src/runtime.js');

    const response = await generate({
      provider: 'openai',
      providerConfig: {
        apiKey: 'test-openai-key',
      },
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Hello',
        },
      ],
      builtIns: false,
      extraTools: [
        {
          name: 'project_lookup',
          description: 'Project lookup',
          parameters: { type: 'object' },
        },
      ],
      context: {
        reasoningEffort: 'low',
      },
    });

    expect(response.content).toBe('generated');
    expect(mockCreateClientForProvider).toHaveBeenCalledWith('openai', {
      apiKey: 'test-openai-key',
    });
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'low',
      webSearch: undefined,
      tools: {
        project_lookup: expect.objectContaining({ name: 'project_lookup' }),
      },
    }));
  });

  it('injects human_intervention_request guidance when the built-in is available', async () => {
    const { DEFAULT_HUMAN_INTERVENTION_TOOL_HINT, generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'openai',
      providerConfig: {
        apiKey: 'test-openai-key',
      },
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'I may need clarification.',
        },
      ],
      builtIns: {
        human_intervention_request: true,
      },
    });

    const request = mockGenerateOpenAIResponse.mock.calls.at(-1)?.[0];
    expect(request?.messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: DEFAULT_HUMAN_INTERVENTION_TOOL_HINT,
      }),
      {
        role: 'user',
        content: 'I may need clarification.',
      },
    ]);
  });

  it('merges human_intervention_request guidance into an existing system message', async () => {
    const { DEFAULT_HUMAN_INTERVENTION_TOOL_HINT, stream } = await import('../../src/runtime.js');

    await stream({
      provider: 'openai',
      providerConfig: {
        apiKey: 'test-openai-key',
      },
      model: 'gpt-5',
      messages: [
        {
          role: 'system',
          content: 'Follow the repo conventions.',
        },
        {
          role: 'user',
          content: 'Proceed carefully.',
        },
      ],
      builtIns: {
        human_intervention_request: true,
      },
    });

    const request = mockStreamOpenAIResponse.mock.calls.at(-1)?.[0];
    expect(request?.messages).toHaveLength(2);
    expect(request?.messages?.[0]).toEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('Follow the repo conventions.'),
    }));
    expect(String(request?.messages?.[0]?.content ?? '')).toContain(DEFAULT_HUMAN_INTERVENTION_TOOL_HINT);
  });

  it('passes explicit OpenAI web search through to the provider adapter', async () => {
    const { generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'openai',
      providerConfig: {
        apiKey: 'test-openai-key',
      },
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Search the web',
        },
      ],
      builtIns: false,
      webSearch: true,
    });

    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      webSearch: {},
    }));
  });

  it('passes explicit Azure OpenAI web search through to the provider adapter', async () => {
    const { generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'azure',
      providerConfig: {
        apiKey: 'test-azure-key',
        resourceName: 'test-resource',
        deployment: 'gpt-4.1',
      },
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Search the web with Azure',
        },
      ],
      builtIns: false,
      webSearch: true,
    });

    expect(mockCreateClientForProvider).toHaveBeenCalledWith('azure', {
      apiKey: 'test-azure-key',
      resourceName: 'test-resource',
      deployment: 'gpt-4.1',
    });
    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'azure',
      webSearch: {},
    }));
  });

  it('treats explicit webSearch false as disabled', async () => {
    const { generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'openai',
      providerConfig: {
        apiKey: 'test-openai-key',
      },
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Do not search the web',
        },
      ],
      builtIns: false,
      webSearch: false,
    });

    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      webSearch: undefined,
    }));
  });

  it('passes explicit Gemini web search through to the provider adapter', async () => {
    const { generate } = await import('../../src/runtime.js');

    const response = await generate({
      provider: 'google',
      providerConfig: {
        apiKey: 'test-google-key',
      },
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: 'Search the web with Gemini',
        },
      ],
      builtIns: false,
      webSearch: true,
    });

    expect(response.content).toBe('google-generated');
    expect(mockCreateGoogleClient).toHaveBeenCalledWith({
      apiKey: 'test-google-key',
    });
    expect(mockGenerateGoogleResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-2.5-flash',
      webSearch: {},
    }));
  });

  it('forwards explicit webSearch to openai-compatible providers', async () => {
    const { generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'openai-compatible',
      providerConfig: {
        apiKey: 'test-openai-compatible-key',
        baseUrl: 'https://example.invalid/v1',
      },
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Try web search',
        },
      ],
      builtIns: false,
      webSearch: {
        searchContextSize: 'medium',
      },
    });

    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai-compatible',
      webSearch: {
        searchContextSize: 'medium',
      },
    }));
  });

  it('does not enable webSearch implicitly for generic openai-compatible providers', async () => {
    const { generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'openai-compatible',
      providerConfig: {
        apiKey: 'test-openai-compatible-key',
        baseUrl: 'https://example.invalid/v1',
      },
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Normal request',
        },
      ],
      builtIns: false,
    });

    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai-compatible',
      webSearch: undefined,
    }));
  });

  it('passes explicit xAI web search through to the provider adapter', async () => {
    const { generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'xai',
      providerConfig: {
        apiKey: 'test-xai-key',
      },
      model: 'grok-3-mini',
      messages: [
        {
          role: 'user',
          content: 'Search the web with xAI',
        },
      ],
      builtIns: false,
      webSearch: true,
    });

    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'xai',
      webSearch: {},
    }));
  });

  it('forwards explicit webSearch to Ollama through the OpenAI-compatible adapter', async () => {
    const { generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'ollama',
      providerConfig: {
        baseUrl: 'http://localhost:11434/v1',
      },
      model: 'llama3.2',
      messages: [
        {
          role: 'user',
          content: 'Search the web with Ollama',
        },
      ],
      builtIns: false,
      webSearch: true,
    });

    expect(mockGenerateOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'ollama',
      webSearch: {},
    }));
  });

  it('passes explicit Anthropic web search through to the provider adapter', async () => {
    const { generate } = await import('../../src/runtime.js');

    await generate({
      provider: 'anthropic',
      providerConfig: {
        apiKey: 'test-anthropic-key',
      },
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: 'Search the web with Anthropic',
        },
      ],
      builtIns: false,
      webSearch: true,
    });

    expect(mockGenerateAnthropicResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-5',
      webSearch: {},
    }));
  });

  it('dispatches per-call stream requests without constructing a runtime', async () => {
    const { stream } = await import('../../src/runtime.js');

    const chunks: Array<{ content?: string; reasoningContent?: string }> = [];
    const response = await stream({
      provider: 'openai',
      providerConfig: {
        apiKey: 'test-openai-key',
      },
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: 'Stream please',
        },
      ],
      builtIns: false,
      onChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(response.content).toBe('streamed');
    expect(chunks).toEqual([
      { content: 'chunk-1' },
      { reasoningContent: 'reasoning-1' },
    ]);
    expect(mockStreamOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'default',
    }));
  });
});
