/**
 * Shared ask_user_input tool contract.
 *
 * Keep the runtime helper and built-in catalog aligned on one canonical
 * description and parameter schema.
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
        'Set true only for explicitly dismissible, non-blocking prompts when it is acceptable for the human to skip without choosing. Do not use allowSkip for approval-gated or otherwise blocking decisions. Omit or false when an answer is required before continuing.',
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
  'Ask a human one or more structured choice questions. Use this tool only after safe read-only inspection or lookup cannot supply the missing information, or when the next step requires approval, a user preference, or another human-only decision such as a required confirmation. Do not ask the human to disambiguate before performing a safe broad search. Use questions[] with stable lowercase question and option ids. Use type: single-select or multiple-select; omit type to default to single-select. Set allowSkip true only for explicitly dismissible, non-blocking prompts when skipping is acceptable; do not use allowSkip for approval-gated or otherwise blocking decisions. Do not add a kind field or approval type. Flat question/options payloads are not supported.';
