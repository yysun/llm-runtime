/**
 * agentic-complete.ts
 *
 * Drop-in style runtime helpers:
 * - generate(): one model call, no tool execution loop
 * - complete(): agentic loop with tool calls, special pause for ask_user_input
 * - streamComplete(): same loop, but emits events as it works
 *
 * Design principle:
 * A normal tool call is executed and the loop continues.
 * ask_user_input is NOT executed as a normal tool. It pauses the run and returns
 * status: "waiting_for_human". To resume, call complete()/streamComplete() again
 * with the returned messages plus the human answer converted through
 * createHumanInputToolResult(...).
 *
 * This file intentionally avoids depending on any specific OpenAI SDK version.
 * You supply a ModelAdapter that knows how to call your provider.
 */

import {
  ASK_USER_INPUT_TOOL_DESCRIPTION,
  ASK_USER_INPUT_TOOL_PARAMETERS,
} from './human-input-contract.js';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content?: string | null;

  /**
   * For assistant messages that contain model tool calls.
   */
  tool_calls?: ToolCall[];

  /**
   * For tool result messages.
   */
  tool_call_id?: string;
  name?: string;

  /**
   * Allow provider-specific extra fields without fighting TypeScript.
   */
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  type?: "function" | string;
  function: {
    name: string;
    /**
     * Usually a JSON string from OpenAI-compatible APIs.
     * Some adapters may already normalize this to an object.
     */
    arguments: string | Record<string, unknown>;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface RuntimeTool {
  /**
   * Tool name as exposed to the model.
   */
  name: string;

  /**
   * Tool schema as passed to the model.
   */
  definition: ToolDefinition;

  /**
   * Normal execution function.
   *
   * Leave undefined for ask_user_input or other interrupt/control tools.
   */
  execute?: (args: unknown, ctx: ToolExecutionContext) => Promise<unknown> | unknown;

  /**
   * Optional kind. You can use this later for approvals, terminal tools, etc.
   * For now, ask_user_input is special-cased by name.
   */
  kind?: "execution" | "human_input" | "approval" | "terminal";
}

export interface ToolExecutionContext {
  toolCall: ToolCall;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface ModelCallInput {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  /**
   * Assistant message returned by the model.
   * It may contain text, tool_calls, or both depending on provider.
   */
  message: ChatMessage;

  /**
   * Provider-specific raw response.
   */
  raw?: unknown;
}

export interface ModelAdapter {
  call(input: ModelCallInput): Promise<ModelResponse>;

  /**
   * Optional streaming model call. If omitted, streamComplete() will still work
   * by using call() internally and emitting coarse events.
   */
  stream?: (input: ModelCallInput) => AsyncIterable<ModelStreamChunk>;
}

export type ModelStreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_delta"; delta: unknown }
  | { type: "message"; message: ChatMessage }
  | { type: "raw"; raw: unknown };

export type CompleteStatus = "completed" | "waiting_for_human" | "failed" | "max_iterations";

export interface CompleteOptions {
  model: ModelAdapter;
  messages: ChatMessage[];
  tools?: RuntimeTool[];

  /**
  * Safety valve. Prevents broken tool loops from spinning forever.
   */
  maxIterations?: number;

  /**
   * Name of the special human-input tool.
   */
  humanInputToolName?: string;

  signal?: AbortSignal;
}

export interface GenerateOptions {
  model: ModelAdapter;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface CompleteResult {
  status: CompleteStatus;
  messages: ChatMessage[];

  /**
   * Final assistant text when completed.
   */
  output?: string | null;

  /**
   * Present when status === "waiting_for_human".
   */
  pendingHumanInput?: PendingHumanInput;

  /**
   * Present when status === "failed" or "max_iterations".
   */
  error?: string;

  raw?: unknown;
}

export interface PendingHumanInput {
  toolCallId: string;
  toolName: string;
  request: unknown;
}

export type StreamCompleteEvent =
  | { type: "model_start"; iteration: number }
  | { type: "assistant_message"; message: ChatMessage; iteration: number }
  | { type: "text_delta"; delta: string; iteration: number }
  | { type: "tool_start"; toolCall: ToolCall; args: unknown; iteration: number }
  | { type: "tool_result"; toolCall: ToolCall; result: unknown; iteration: number }
  | { type: "tool_error"; toolCall: ToolCall; error: string; iteration: number }
  | { type: "waiting_for_human"; pendingHumanInput: PendingHumanInput; messages: ChatMessage[]; iteration: number }
  | { type: "completed"; result: CompleteResult; iteration: number }
  | { type: "failed"; result: CompleteResult; iteration: number }
  | { type: "raw"; raw: unknown; iteration: number };

/* -------------------------------------------------------------------------- */
/* Public functions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * generate()
 *
 * One model call. No agentic loop. No tool execution.
 *
 * Use this for:
 * - chat title generation
 * - classification
 * - simple summary
 * - one-shot responses
 */
export async function generate(options: GenerateOptions): Promise<ModelResponse> {
  return options.model.call({
    messages: options.messages,
    tools: options.tools,
    signal: options.signal,
  });
}

/**
 * complete()
 *
 * Agentic loop:
 * - call model
 * - if normal tool calls: execute tools, append tool results, continue
 * - if ask_user_input: pause and return waiting_for_human
 * - if assistant text: treat it as the terminal answer for this run
 */
export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  let finalResult: CompleteResult | undefined;

  for await (const event of streamComplete(options)) {
    if (event.type === "completed" || event.type === "failed") {
      finalResult = event.result;
    }

    if (event.type === "waiting_for_human") {
      return {
        status: "waiting_for_human",
        messages: event.messages,
        pendingHumanInput: event.pendingHumanInput,
      };
    }
  }

  return (
    finalResult ?? {
      status: "failed",
      messages: options.messages,
      error: "streamComplete() ended without a terminal event.",
    }
  );
}

/**
 * streamComplete()
 *
 * Same logic as complete(), but yields lifecycle events.
 *
 * This is the function your SSE endpoint should normally wrap.
 */
export async function* streamComplete(options: CompleteOptions): AsyncGenerator<StreamCompleteEvent> {
  const {
    model,
    tools = [],
    maxIterations = 30,
    humanInputToolName = "ask_user_input",
    signal,
  } = options;

  const messages = [...options.messages];
  const toolMap = new Map<string, RuntimeTool>();

  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  const toolDefinitions = tools.map((tool) => tool.definition);

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    throwIfAborted(signal);

    yield { type: "model_start", iteration };

    let response: ModelResponse;

    try {
      response = await callModelMaybeStreaming(model, {
        messages,
        tools: toolDefinitions,
        signal,
      }, iteration, yieldEvent);
    } catch (error) {
      const result: CompleteResult = {
        status: "failed",
        messages,
        error: stringifyError(error),
      };
      yield { type: "failed", result, iteration };
      return;
    }

    const assistantMessage = response.message;
    messages.push(assistantMessage);

    yield { type: "assistant_message", message: assistantMessage, iteration };

    const toolCalls = assistantMessage.tool_calls ?? [];

    if (toolCalls.length > 0) {
      const humanInputToolCalls = toolCalls.filter((toolCall) => {
        const runtimeTool = toolMap.get(toolCall.function.name);
        return toolCall.function.name === humanInputToolName || runtimeTool?.kind === "human_input";
      });

      if (humanInputToolCalls.length > 0) {
        if (toolCalls.length !== 1 || humanInputToolCalls.length !== 1) {
          const result: CompleteResult = {
            status: "failed",
            messages,
            error: `Assistant mixed ask_user_input with other tool calls in the same turn. ask_user_input must be the only tool call when pausing for human input.`,
            raw: response.raw,
          };

          yield { type: "failed", result, iteration };
          return;
        }

        const humanInputToolCall = humanInputToolCalls[0];
        const pendingHumanInput: PendingHumanInput = {
          toolCallId: humanInputToolCall.id,
          toolName: humanInputToolCall.function.name,
          request: parseToolArguments(humanInputToolCall.function.arguments),
        };

        yield {
          type: "waiting_for_human",
          pendingHumanInput,
          messages,
          iteration,
        };

        return;
      }

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const args = parseToolArguments(toolCall.function.arguments);
        const runtimeTool = toolMap.get(toolName);

        if (!runtimeTool) {
          const error = `Unknown tool: ${toolName}`;
          messages.push(createToolResultMessage(toolCall, { error }));
          yield { type: "tool_error", toolCall, error, iteration };
          continue;
        }

        if (!runtimeTool.execute) {
          const error = `Tool "${toolName}" has no execute() function. If this is a control tool, handle it before normal execution.`;
          messages.push(createToolResultMessage(toolCall, { error }));
          yield { type: "tool_error", toolCall, error, iteration };
          continue;
        }

        yield { type: "tool_start", toolCall, args, iteration };

        try {
          const result = await runtimeTool.execute(args, {
            toolCall,
            messages,
            signal,
          });

          messages.push(createToolResultMessage(toolCall, result));
          yield { type: "tool_result", toolCall, result, iteration };
        } catch (error) {
          const errorText = stringifyError(error);
          messages.push(createToolResultMessage(toolCall, { error: errorText }));
          yield { type: "tool_error", toolCall, error: errorText, iteration };
        }
      }

      // Tool results were appended. Continue the agentic loop.
      continue;
    }

    const text = assistantMessage.content ?? null;

    if (!text?.trim()) {
      const result: CompleteResult = {
        status: "failed",
        messages,
        error: "Assistant returned neither tool calls nor non-empty text.",
        raw: response.raw,
      };

      yield { type: "failed", result, iteration };
      return;
    }

    const result: CompleteResult = {
      status: "completed",
      messages,
      output: text,
      raw: response.raw,
    };

    yield { type: "completed", result, iteration };
    return;

    /**
     * This local helper allows callModelMaybeStreaming() to yield stream chunks
     * without making the whole function harder to read.
     */
    async function yieldEvent(event: StreamCompleteEvent): Promise<void> {
      // Placeholder. Async generators cannot yield from nested callbacks directly.
      // callModelMaybeStreaming currently buffers streaming to a final message.
      // Keep this here so the shape is ready if you later wire provider-native
      // chunk forwarding.
      void event;
    }
  }

  const result: CompleteResult = {
    status: "max_iterations",
    messages,
    error: `Reached maxIterations=${maxIterations} before completion.`,
  };

  yield { type: "failed", result, iteration: maxIterations };
}

/* -------------------------------------------------------------------------- */
/* Resume helper                                                               */
/* -------------------------------------------------------------------------- */

/**
 * createHumanInputToolResult()
 *
 * When complete()/streamComplete() returns waiting_for_human, store:
 * - result.messages
 * - result.pendingHumanInput
 *
 * After the user answers, append this message to result.messages and call
 * complete()/streamComplete() again.
 *
 * Example:
 *
 * const waiting = await complete(...)
 *
 * const resumedMessages = [
 *   ...waiting.messages,
 *   createHumanInputToolResult(waiting.pendingHumanInput!, {
 *     answers: { "entity-type": "contact" }
 *   })
 * ]
 *
 * const final = await complete({ ...options, messages: resumedMessages })
 */
export function createHumanInputToolResult(
  pending: PendingHumanInput,
  answer: unknown,
): ChatMessage {
  return {
    role: "tool",
    tool_call_id: pending.toolCallId,
    name: pending.toolName,
    content: JSON.stringify(answer),
  };
}

export function createAskUserInputResult(
  pending: PendingHumanInput,
  answer: unknown,
): ChatMessage {
  return createHumanInputToolResult(pending, answer);
}

/* -------------------------------------------------------------------------- */
/* Suggested ask_user_input tool definition                                    */
/* -------------------------------------------------------------------------- */

export const askUserInputTool: RuntimeTool = {
  name: "ask_user_input",
  kind: "human_input",
  definition: {
    type: "function",
    function: {
      name: "ask_user_input",
      description: ASK_USER_INPUT_TOOL_DESCRIPTION,
      parameters: ASK_USER_INPUT_TOOL_PARAMETERS,
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

async function callModelMaybeStreaming(
  model: ModelAdapter,
  input: ModelCallInput,
  _iteration: number,
  _yieldEvent: (event: StreamCompleteEvent) => Promise<void>,
): Promise<ModelResponse> {
  // Keep this deliberately simple.
  //
  // Most OpenAI-compatible streaming APIs require provider-specific assembly
  // of tool call deltas. That belongs in your ModelAdapter.
  //
  // This runtime expects the adapter to return one normalized assistant message.
  // If you already have stream assembly in your existing code, put it behind
  // model.stream() or model.call().
  return model.call(input);
}

function parseToolArguments(value: string | Record<string, unknown>): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (value.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    // Do not throw here. Bad tool JSON should be visible to the model as a tool
    // error/result so it can self-correct if possible.
    return {
      _parseError: "Tool arguments were not valid JSON.",
      _raw: value,
    };
  }
}

function createToolResultMessage(toolCall: ToolCall, result: unknown): ChatMessage {
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    content: stringifyToolResult(result),
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted.");
  }
}
