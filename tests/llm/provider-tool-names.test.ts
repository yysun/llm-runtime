/**
 * LLM Package Provider Tool Name Helper Tests
 *
 * Purpose:
 * - Validate shared provider-facing tool-name translation behavior used by function-calling adapters.
 *
 * Recent changes:
 * - 2026-05-15: Added collision, long-name, and reserved-provider-name coverage.
 */

import { describe, expect, it } from 'vitest';
import { createProviderToolNameTranslator } from '../../src/provider-tool-names.js';

describe('llm-runtime provider-tool-names', () => {
  it('keeps provider names safe, bounded, collision-free, and reversible', () => {
    const firstRuntimeName = 'alpha.tool';
    const secondRuntimeName = 'alpha/tool';
    const reservedCollisionName = 'web.search';
    const longRuntimeName = 'demo.server.lookup.tool.with.invalid.characters.and.a.very.long.suffix.that.must.be.shortened';

    const translator = createProviderToolNameTranslator({
      [firstRuntimeName]: {
        name: firstRuntimeName,
        description: 'First tool',
        parameters: { type: 'object' },
      },
      [secondRuntimeName]: {
        name: secondRuntimeName,
        description: 'Second tool',
        parameters: { type: 'object' },
      },
      [reservedCollisionName]: {
        name: reservedCollisionName,
        description: 'Reserved collision tool',
        parameters: { type: 'object' },
      },
      [longRuntimeName]: {
        name: longRuntimeName,
        description: 'Long tool',
        parameters: { type: 'object' },
      },
    }, {
      maxLength: 32,
      reservedProviderNames: ['web_search'],
    });

    const firstProviderName = translator.toProviderName(firstRuntimeName);
    const secondProviderName = translator.toProviderName(secondRuntimeName);
    const reservedCollisionProviderName = translator.toProviderName(reservedCollisionName);
    const longProviderName = translator.toProviderName(longRuntimeName);

    expect(firstProviderName).toBe('alpha_tool');
    expect(secondProviderName).not.toBe(firstProviderName);
    expect(secondProviderName).toMatch(/^alpha_tool_[A-Za-z0-9]+$/);
    expect(reservedCollisionProviderName).not.toBe('web_search');
    expect(longProviderName).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(longProviderName.length).toBeLessThanOrEqual(32);
    expect(new Set([
      firstProviderName,
      secondProviderName,
      reservedCollisionProviderName,
      longProviderName,
    ]).size).toBe(4);

    expect(translator.toRuntimeName(firstProviderName)).toBe(firstRuntimeName);
    expect(translator.toRuntimeName(secondProviderName)).toBe(secondRuntimeName);
    expect(translator.toRuntimeName(reservedCollisionProviderName)).toBe(reservedCollisionName);
    expect(translator.toRuntimeName(longProviderName)).toBe(longRuntimeName);
    expect(translator.toRuntimeName('web_search')).toBe('web_search');
  });
});