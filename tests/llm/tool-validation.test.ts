/**
 * LLM Package Tool Validation Tests
 *
 * Purpose:
 * - Validate recursive schema enforcement for package-owned tool validation.
 *
 * Key features:
 * - Covers nested required fields, enums, minItems, and additionalProperties handling.
 * - Confirms valid nested payloads still pass through with normalized arguments.
 *
 * Implementation notes:
 * - Exercises the validator directly so failures stay isolated from runtime orchestration tests.
 *
 * Recent changes:
 * - 2026-05-15: Added recursive validation coverage for nested object and array schemas.
 */

import { describe, expect, it } from 'vitest';
import { validateToolParameters } from '../../src/tool-validation.js';

describe('llm-runtime tool validation', () => {
  it('rejects invalid nested object and array payloads', () => {
    const result = validateToolParameters({
      questions: [{
        header: 'Mode',
        kind: 'approval',
        options: [{ id: 'yes' }],
        extra: true,
      }],
    }, {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              header: { type: 'string' },
              kind: { type: 'string', enum: ['single-select', 'multiple-select'] },
              options: {
                type: 'array',
                minItems: 2,
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                  },
                  required: ['id', 'label'],
                  additionalProperties: false,
                },
              },
            },
            required: ['header', 'kind', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    }, 'ask_user_input');

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'questions[0].kind', code: 'invalid_type' }),
      expect.objectContaining({ path: 'questions[0].options', code: 'invalid_type' }),
      expect.objectContaining({ path: 'questions[0].options[0].label', code: 'missing_required' }),
      expect.objectContaining({ path: 'questions[0].extra', code: 'unknown_parameter' }),
    ]));
  });

  it('accepts valid nested payloads and preserves corrected arguments', () => {
    const result = validateToolParameters({
      config: {
        retries: '3',
        steps: [{ action: 'read' }, { action: 'write' }],
      },
    }, {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            retries: { type: 'number' },
            steps: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['read', 'write'] },
                },
                required: ['action'],
                additionalProperties: false,
              },
            },
          },
          required: ['retries', 'steps'],
          additionalProperties: false,
        },
      },
      required: ['config'],
      additionalProperties: false,
    }, 'nested_tool');

    expect(result.valid).toBe(true);
    expect(result.correctedArgs).toEqual({
      config: {
        retries: 3,
        steps: [{ action: 'read' }, { action: 'write' }],
      },
    });
  });
});