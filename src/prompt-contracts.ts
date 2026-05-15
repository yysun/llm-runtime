import type { LLMChatMessage } from './types.js';

const AGENT_RUN_LOOP_PROMPT_MARKER = 'You are operating inside an agent run loop.';

const AGENT_RUN_LOOP_PROMPT_BLOCK = [
  AGENT_RUN_LOOP_PROMPT_MARKER,
  '',
  'Your job is to continue until the user\'s task is complete, blocked, or requires user input.',
  '',
  'You may briefly tell the user what you are about to do, but narration is not completion. Do not stop after merely announcing intent.',
  '',
  'Prefer action over explanation.',
  '',
  'If the task requires workspace inspection, file access, search, lookup, command execution, or tool use, call the appropriate tool.',
  '',
  'For safe read-only work, such as inspection, lookup, search, summarization, or analysis, use the available tools without asking for confirmation.',
  '',
  'Do not ask the user to disambiguate before safe discovery. If multiple files, records, people, entities, locations, or tools may match, search broadly first and present the likely matches.',
  '',
  'Use ask_user_input only when:',
  '- the missing input cannot be safely discovered,',
  '- the user must choose a preference,',
  '- approval is required,',
  '- the next step causes a side effect,',
  '- or safety/permission rules require it.',
  '',
  'If you call ask_user_input, do not repeat the same question in plain assistant text.',
  '',
  'After the user answers, use the answer immediately and continue the task unless the task is already complete.',
  '',
  'You may stop only by:',
  '- calling a tool,',
  '- giving a complete final answer,',
  '- calling ask_user_input for required input,',
  '- or reporting a real permission, capability, or safety block.',
].join('\n');

export const COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG = 'llm-runtime-loop-contract';

export const DEFAULT_HUMAN_INTERVENTION_TOOL_HINT = [
  'Use `ask_user_input` only for required human decisions. Do not use it as a substitute for safe read-only lookup, search, or inspection.',
  'Do not ask the user to disambiguate before performing a safe broad read-only search. If ambiguity can be resolved safely through read-only tools, search first and present matches.',
  'Treat phrases such as "ask the user", "request approval", or "HITL" as referring to this tool when present.',
  'Use `allowSkip` only for non-blocking prompts, not required approvals or blocking decisions.',
  'Do not invent human answers.',
].join(' ');

export const DEFAULT_WORKSPACE_TOOL_HINT = [
  'Prefer `list_files`, `search_files`, `read_file`, `path_exists`, and `create_directory` for normal workspace exploration.',
  'Use `shell_cmd` only for explicit commands, git workflows, or gaps in the structured tools.',
  'With `shell_cmd`, send one command plus `parameters`, not a pipeline string.',
  'Preferred shell patterns: `rg --files`, `rg "pattern"`, `find`, `sed -n "1,200p" path`, `head -n 200 path`, `tail -n 100 path`.',
  'Prefer `rg` over `grep`, and `head` or `sed -n` over `cat` for bounded reads.',
  'On Windows, use PowerShell-native commands only if they still fit the same single-command model.',
].join(' ');

export type ManagedSystemPromptOptions = {
  includeAgentRunLoopContract?: boolean;
  includeHumanInterventionHint?: boolean;
  includeWorkspaceToolHint?: boolean;
};

export function buildManagedSystemPrompt(options: ManagedSystemPromptOptions): string {
  const sections: string[] = [];

  if (options.includeAgentRunLoopContract) {
    sections.push(AGENT_RUN_LOOP_PROMPT_BLOCK);
  }

  if (options.includeHumanInterventionHint) {
    sections.push(DEFAULT_HUMAN_INTERVENTION_TOOL_HINT);
  }

  if (options.includeWorkspaceToolHint) {
    sections.push(DEFAULT_WORKSPACE_TOOL_HINT);
  }

  return sections.join('\n\n');
}

export const DEFAULT_AGENT_RUN_LOOP_SYSTEM_PROMPT = buildManagedSystemPrompt({
  includeAgentRunLoopContract: true,
});

export function containsAgentRunLoopSystemPrompt(content: string): boolean {
  return content.includes(AGENT_RUN_LOOP_PROMPT_MARKER);
}

export function formatManagedSystemPromptBlock(prompt: string): string {
  return [
    `<${COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG}>`,
    prompt,
    `</${COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG}>`,
  ].join('\n');
}

function stripManagedSystemPromptBlocks(content: string): string {
  return content
    .replace(
      new RegExp(`<${COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG}>[\\s\\S]*?<\\/${COMPLETION_LOOP_SYSTEM_PROMPT_SECTION_TAG}>`, 'g'),
      '',
    )
    .trim();
}

export function upsertManagedSystemPrompt<TMessage extends LLMChatMessage>(
  messages: TMessage[],
  options: ManagedSystemPromptOptions,
): TMessage[] {
  const prompt = buildManagedSystemPrompt(options);
  const promptBlock = formatManagedSystemPromptBlock(prompt);
  const systemMessageIndex = messages.findIndex((message) => message.role === 'system');

  if (systemMessageIndex >= 0) {
    const systemMessage = messages[systemMessageIndex];
    const existingContent = String(systemMessage?.content ?? '');
    const baseContent = stripManagedSystemPromptBlocks(existingContent);
    const nextContent = baseContent.trim()
      ? `${baseContent}\n\n${promptBlock}`
      : promptBlock;

    if (existingContent === nextContent) {
      return messages;
    }

    const nextMessages = messages.slice();
    nextMessages[systemMessageIndex] = {
      ...systemMessage,
      content: nextContent,
    };
    return nextMessages;
  }

  return [
    { role: 'system', content: promptBlock } as TMessage,
    ...messages,
  ];
}