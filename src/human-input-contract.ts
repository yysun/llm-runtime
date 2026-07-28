/**
 * Shared ask_user_input tool contract.
 *
 * Keep the runtime helper and built-in catalog aligned on one canonical
 * description and parameter schema.
 *
 * Recent changes:
 * - 2026-07-28: Separated preference input from executable approval and added
 *   explicit per-question free-form answer support.
 */

export const ASK_USER_INPUT_TOOL_PARAMETERS = {
  type: 'object',
  description:
    'Provide questions[] with stable ids and options. Flat question/options payloads are not supported.',
  properties: {
    type: {
      type: 'string',
      enum: ['single-select', 'multiple-select'],
      description:
        'Selection mode for all questions. Use single-select for exactly one choice, multiple-select when the human may choose more than one. Omit to default to single-select. Do not use kind or approval.',
    },
    allowSkip: {
      type: 'boolean',
      description:
        'Set true when the host may dismiss the prompt. Dismissal is a cancelled outcome and never implies consent or execution authorization. Omit or false when the host UI must require an answer.',
    },
    questions: {
      type: 'array',
      description:
        'Required field. Provide one or more structured questions; each question must include at least two options.',
      items: {
        type: 'object',
        description: 'One question to show to the human.',
        properties: {
          header: {
            type: 'string',
            description:
              'Short UI header, usually 1-3 words, such as "Approval", "Scope", or "Tests".',
          },
          id: {
            type: 'string',
            description:
              'Stable machine-readable question id. Use lowercase kebab-case or snake_case, such as "test-scope" or "deploy_approval".',
          },
          question: {
            type: 'string',
            description:
              'Clear question shown to the human. Ask for the missing decision or input directly.',
          },
          allowOther: {
            type: 'boolean',
            description:
              'Set true only for a single-select question that accepts a non-empty free-form answer outside the declared option ids. Omit or false to require a declared option id.',
          },
          options: {
            type: 'array',
            description:
              'Selectable options. Provide at least two options. Use stable option ids for answer handling; labels are display text.',
            items: {
              type: 'object',
              description: 'One selectable option.',
              properties: {
                id: {
                  type: 'string',
                  description:
                    'Stable machine-readable option id. Prefer lowercase kebab-case or snake_case, such as "approve", "reject", "run-tests", or "skip-tests".',
                },
                label: {
                  type: 'string',
                  description:
                    'Short user-facing option label, such as "Approve", "Reject", or "Run tests".',
                },
                description: {
                  type: 'string',
                  description:
                    'Optional one-sentence clarification of what selecting this option means.',
                },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
          },
        },
        required: ['header', 'id', 'question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

export const ASK_USER_INPUT_TOOL_DESCRIPTION =
  'Ask a human one or more structured clarification or preference questions. Use this tool only after safe read-only inspection or lookup cannot supply the missing information, or when a human-only preference or workflow decision is required. This tool does not authorize execution of a later tool call; executable approval belongs to the host approval gate for the exact tool call and arguments. Do not ask the human to disambiguate before performing a safe broad search. Use questions[] with stable lowercase question and option ids. Use type: single-select or multiple-select; omit type to default to single-select. Set allowSkip true when dismissal should produce a cancelled outcome; dismissal never implies consent. Set allowOther true only on a single-select question that accepts free-form input. Do not add a kind field or approval type. Flat question/options payloads are not supported.';
