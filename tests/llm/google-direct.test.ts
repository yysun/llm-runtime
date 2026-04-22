/**
 * LLM Package Google Provider Tests
 *
 * Purpose:
 * - Validate the package-owned Google provider helper request mapping without real SDK traffic.
 */

import { describe, expect, it } from 'vitest';
import { createGoogleModel, generateGoogleResponse } from '../../src/google-direct.js';

describe('llm-runtime google-direct', () => {
  it('adds Gemini Google Search grounding when web search is enabled', async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const fakeModel = {
      generateContent: async () => ({
        response: {
          text: () => 'google search enabled',
          candidates: [],
        },
      }),
    };

    const fakeClient = {
      getGenerativeModel: (options: Record<string, unknown>) => {
        capturedOptions = options;
        return fakeModel;
      },
    } as any;

    await generateGoogleResponse({
      client: fakeClient,
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: 'Search the web',
        },
      ],
      webSearch: {},
    });

    expect(capturedOptions).toEqual(expect.objectContaining({
      tools: [
        {
          googleSearchRetrieval: {},
        },
      ],
    }));
  });

  it('merges Gemini search grounding with function declarations', async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const fakeModel = {
      generateContent: async () => ({
        response: {
          text: () => 'google tools enabled',
          candidates: [],
        },
      }),
    };

    const fakeClient = {
      getGenerativeModel: (options: Record<string, unknown>) => {
        capturedOptions = options;
        return fakeModel;
      },
    } as any;

    await generateGoogleResponse({
      client: fakeClient,
      model: 'gemini-2.5-flash',
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
      webSearch: {},
    });

    expect(capturedOptions).toEqual(expect.objectContaining({
      tools: [
        {
          functionDeclarations: [
            expect.objectContaining({
              name: 'lookup',
            }),
          ],
        },
        {
          googleSearchRetrieval: {},
        },
      ],
    }));
  });

  it('lets createGoogleModel accept structured Gemini tools', () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const fakeClient = {
      getGenerativeModel: (options: Record<string, unknown>) => {
        capturedOptions = options;
        return { model: 'fake' };
      },
    } as any;

    createGoogleModel(fakeClient, 'gemini-2.5-flash', [
      {
        functionDeclarations: [
          {
            name: 'lookup',
            description: 'Look something up',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
      {
        googleSearchRetrieval: {},
      },
    ]);

    expect(capturedOptions).toEqual(expect.objectContaining({
      tools: [
        {
          functionDeclarations: [
            expect.objectContaining({ name: 'lookup' }),
          ],
        },
        {
          googleSearchRetrieval: {},
        },
      ],
    }));
  });
});