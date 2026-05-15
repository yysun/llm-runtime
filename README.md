# `llm-runtime`

`llm-runtime` is a runtime layer for application-owned LLM workflows. It wraps provider invocation with one package boundary for tool orchestration, MCP integration, and skill loading.

This package is designed for harnesses that want a stable per-call API without pushing provider-specific details, built-in tool contracts, MCP wiring, and skill discovery into application code.

> It is extracted from the [Agent World](https://github.com/yysun/agent-world) to be a standalone dependency for any application that needs provider calls with tool calls, MCP and agent skill support to build your own full agent orchestration or harness.

## Installation

```bash
npm install llm-runtime
```

The published package targets Node.js 18 and later and exposes a single root entrypoint.

## What This Package Owns

- Provider dispatch for `generate(...)`
- Bound runtime-facade agentic helpers through `runtime.complete(...)` and `runtime.streamComplete(...)`
- Generic host-agnostic completion orchestration through `complete(...)`, with `runCompletionLoop(...)` as the lower-level API
- Intrinsic completion-loop safety limits, stop semantics, trace summaries, and lifecycle hooks
- Built-in tools such as file access, shell execution, and skill loading
- MCP tool discovery and execution
- Skill discovery from configured skill roots
- Stable runtime-level registries for MCP servers and skills
- Cleanup boundaries for explicit runtimes and convenience-path caches

## Public API

- `createRuntime(...)`
- `createHumanInputToolResult(...)`
- `createAskUserInputResult(...)`
- `runtime.generate(...)`
- `runtime.complete(...)`
- `runtime.streamComplete(...)`
- `runtime.dispose()`
- `disposeRuntimeCaches()`
- `generate(...)`
- `executeToolCall(...)`
- `executeToolCalls(...)`
- `resolveTools(...)`
- `resolveToolsAsync(...)`
- `complete(...)`
- `runCompletionLoop(...)`

The package is per-call first. You can call `generate(...)` directly, use `complete(...)` or `runCompletionLoop(...)` for callback-driven orchestration, or create an explicit `runtime` when your harness wants stable provider, MCP, and skill dependencies plus bound agentic helpers.

## Cleanup

Use the public cleanup APIs when the runtime owns MCP clients or cached tool-discovery state:

- `runtime.dispose()` shuts down the runtime MCP registry only when that registry was created by the runtime.
- `disposeRuntimeCaches()` shuts down cached convenience-path MCP registries and clears cached provider, MCP, and skill discovery state.

Ownership is split deliberately:

- The runtime owns cleanup for runtimes created for runtime use and for the convenience-path caches it creates internally.
- The harness still owns temporary workspaces, transcript persistence, any caller-injected registries, and any other non-runtime resources attached to its application.

## Mental Model

The main rule is simple:

- Stable harness state belongs in `runtime`
- Request-specific state stays per call

### Put This In `runtime`

- Provider configuration store
- MCP registry or MCP config
- Skill registry or skill roots
- Default `reasoningEffort`
- Default `toolPermission`

### Keep This Per Call

- `provider`
- `model`
- `messages`
- `workingDirectory`
- `reasoningEffort`
- `toolPermission`
- `webSearch`
- `abortSignal`

If a value should change from one request or UI action to the next, it usually should not live in the runtime.

## Tool Model

`llm-runtime` merges several tool sources into one callable surface.

### Built-In Tools

The minimal runtime core does not require any built-in operational tools. The built-ins below are optional package-owned convenience capabilities exposed from the same package surface.

The package currently reserves these built-in names:

- `shell_cmd`
- `load_skill`
- `ask_user_input`
- `web_fetch`
- `read_file`
- `write_file`
- `list_files`
- `search_files`
- `create_directory`
- `path_exists`

Built-ins are package-owned and reserved. Application code can disable or narrow them, but should not redefine them.

When `builtIns` is omitted, the package now exposes a read-only default set:

- `load_skill`
- `list_files`
- `search_files`
- `read_file`
- `path_exists`

Write-capable or interactive built-ins such as `shell_cmd`, `write_file`, `create_directory`, `web_fetch`, and `ask_user_input` require explicit opt-in. Pass `builtIns: true` or `builtIns: 'all'` to opt back into the full package-owned set.

For routine workspace operations, prefer the structured built-ins over `shell_cmd`:

- `list_files` for directory listing
- `search_files` for glob-like file discovery
- `read_file` for bounded file inspection
- `path_exists` for file or directory existence checks
- `create_directory` for directory creation

Treat `shell_cmd` as a fallback for explicit command execution, git workflows, and cases the structured workspace tools do not cover.

`search_files` is the built-in file-discovery tool for glob-like path matching. `create_directory` creates directories recursively inside the trusted working directory. `path_exists` reports whether a file or directory currently exists and, when it does, whether it is a file or directory.

`ask_user_input` is the public built-in human-intervention tool. The older `human_intervention_request` and `ask_user_question` names are no longer part of the public tool surface.

When the built-in human-intervention tool is enabled, the runtime also injects a small system-level hint telling the model to prefer that tool for clarification, approval, and other human-in-the-loop decisions. This helps generic skills that say things like "ask the user" or "use an ask-question tool" map onto the built-in HITL tool without each skill naming it explicitly.

The tool descriptions and the loop-contract system prompt both instruct the model to reach for `ask_user_input` only after safe read-only inspection or lookup cannot supply the missing information, or when the next step requires approval, a user preference, or another human-only decision. Safe broad searches should happen before HITL disambiguation prompts.

`ask_user_input` should usually be enabled for interactive harnesses that can pause, surface a question to a human, and then resume with the selected answer. It should usually be disabled for unattended batch runs, deterministic tests, or autonomous workflows that are not allowed to wait for human input.

The `ask_user_input` parameter shape is:

```ts
{
  type?: "single-select" | "multiple-select";
  allowSkip?: boolean;
  questions: Array<{
    header: string;
    id: string;
    question: string;
    options: Array<{
      id: string;
      label: string;
      description?: string;
    }>;
  }>;
}
```

Omitting `type` defaults to `single-select`. Omitting `allowSkip` defaults to `false`. Use `allowSkip: true` only for explicitly dismissible, non-blocking prompts. Do not use `allowSkip` for approval-gated or otherwise blocking decisions; leave it omitted or `false` when the run must wait for a human answer before continuing. Option `id` values are the stable machine-readable values that harnesses should use when resuming from a human answer; labels are display text.

Flat `question` / `options` payloads are not supported. Use `questions[]` for all HITL prompts.

### Extra Tools

Extra tools are application-specific additions such as `lookup_customer` or `create_ticket`. They are additive only and cannot override reserved built-in names.

### MCP Tools

MCP tools come from configured external servers. The runtime discovers them, namespaces them, and merges them into the same resolved tool set as built-ins and extra tools.

### Skills

Skills are reusable instruction assets discovered from skill roots and loaded through `load_skill`. Skills are not executable tools; they add instruction context for the model.

## Web Search

`llm-runtime` can enable or forward per-call web search across the package provider set.

- Per call, pass `webSearch: true` or `webSearch: { searchContextSize: 'low' | 'medium' | 'high' }`.
- `webSearch` is mapped to provider-native request fields for `openai`, `anthropic`, and `google`.
- For `azure`, `openai-compatible`, `xai`, and `ollama` on the current chat-API path, unsupported `webSearch` is ignored instead of failing the request.
- Anthropic uses its built-in `web_search_20250305` server tool.
- Gemini uses Google Search grounding, but Gemini built-in Google Search cannot be combined with function calling in the same request. When both `tools` and `webSearch` are present for `google`, `llm-runtime` keeps function calling and ignores `webSearch`.
- When `webSearch` is ignored, the returned `LLMResponse` includes a `warnings` entry with code `web_search_ignored` so harnesses can surface the downgrade without failing the turn.
- `searchContextSize` is forwarded for OpenAI-style requests and ignored by Anthropic and Gemini.
- Omit `webSearch` to leave web search disabled.

## `runtime.complete(...)` / `runtime.streamComplete(...)`

The runtime facade exposes a package-owned agentic helper for harnesses that want one bounded tool loop without wiring `runCompletionLoop(...)` callbacks by hand.

The runtime helper contract is intentionally simple:

- If the assistant returns one or more normal tool calls, the runtime executes them, appends tool results, and continues the loop.
- If the assistant calls `ask_user_input` as the only tool call in the turn, the runtime pauses and returns `status: 'waiting_for_human'` instead of executing that tool.
- If the assistant mixes `ask_user_input` with any other tool call in the same turn, the runtime fails the turn instead of partially executing tools before pausing.
- If the assistant returns plain text without tool calls, that text is terminal for the run, even if it narrates future work like "I will...".
- If the assistant returns neither tool calls nor non-empty text, the runtime fails the turn.
- If the loop does not reach a terminal state before `maxIterations`, it returns `status: 'max_iterations'`.

This simple runtime helper does not apply the generic `complete(...)` hardening and text-classification callbacks described later in this README. Use `complete(...)` or `runCompletionLoop(...)` when your harness needs callback-driven recovery, custom text classification, or package-managed control-tool handling.

When a run pauses for human input, resume it by appending a tool-result message created with `createHumanInputToolResult(...)` or `createAskUserInputResult(...)` and then calling `runtime.complete(...)` or `runtime.streamComplete(...)` again.

Minimal resume pattern:

```ts
import {
  createHumanInputToolResult,
  createRuntime,
} from 'llm-runtime';

const runtime = createRuntime({
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
    },
  },
});

const firstPass = await runtime.complete({
  provider: 'openai',
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Do the task and ask me if you need a choice.' }],
  builtIns: {
    ask_user_input: true,
    read_file: true,
  },
});

if (firstPass.status === 'waiting_for_human') {
  const resumedMessages = [
    ...firstPass.messages,
    createHumanInputToolResult(firstPass.pendingHumanInput, {
      answers: {
        scope: 'all',
      },
    }),
  ];

  const resumed = await runtime.complete({
    provider: 'openai',
    model: 'gpt-5',
    messages: resumedMessages,
    builtIns: {
      ask_user_input: true,
      read_file: true,
    },
  });

  if (resumed.status === 'completed') {
    console.log(resumed.output);
  }
}
```

## `complete(...)` / `runCompletionLoop(...)`

`complete(...)` is the preferred user-facing name for the package-owned iterative loop that manages repeated model turns without taking ownership of harness state, persistence, or tool policy.

`runCompletionLoop(...)` is the preferred lower-level API when a harness wants to opt out of some package defaults.

Use it when your harness needs more control than a single `generate(...)` call, but still wants one package boundary for:

- repeated model invocation
- empty-text retry handling
- optional plain-text tool-intent normalization
- hard iteration, tool-round, repeated-call, and wall-clock safety bounds
- structured trace summaries and lifecycle hooks

The split of responsibilities is deliberate:

- The package owns loop repetition, hard-stop safety checks, response normalization, trace collection, and lifecycle hook ordering.
- The harness owns state shape, tool execution, persistence, replay, and business-specific final-answer overrides.
- `complete(...)` still calls your `buildMessages(...)` callback, but it merges a package-owned agent-run-loop contract into the first system message so the default tool-loop contract is not client-dependent and caller system intent stays in one place.

### Safety And Stop Reasons

`complete(...)` now applies intrinsic package defaults for:

- `maxIterations`
- `maxConsecutiveToolTurns`
- `maxWallTimeMs`
- repeated identical tool-call suppression through `repeatedToolCallGuard`
- `defaultTextResponseMode: 'require_tool_result'`, which rejects unresolved plain text before any observed tool result unless the harness explicitly overrides classification
- `rejectedTextRetryLimit: 2`, so unresolved tool-capable text gets two internal correction turns by default before the loop stops
- `DEFAULT_COMPLETION_LOOP_SYSTEM_PROMPT`, which is merged into the first system message automatically so tool-capable callers get a runtime-owned completion-loop contract by default

`runCompletionLoop(...)` keeps `defaultTextResponseMode: 'permissive'` unless the caller opts into stricter behavior.

Terminal reasons are stable string literals suitable for harness branching:

- `text_response`
- `tool_calls_response`
- `empty_text_stop`
- `rejected_text_response`
- `unhandled_response`
- `max_iterations_exceeded`
- `max_tool_rounds_exceeded`
- `timeout`
- `repeated_tool_call_stopped`

In agent control mode, the loop also supports deterministic terminal control tools:

- `final_answer`
- `need_user_input`
- `blocked`

`complete(...)` enables agent control mode automatically when you use the package-managed `modelRequest` path. In that mode, the runtime injects those internal control-tool definitions through `modelRequest.extraTools`, intercepts them before host tool execution, and returns structured terminal metadata instead of relying on bare assistant text.

When agent control mode is enabled, bare text is protocol-invalid by default. The loop retries or stops it as `rejected_text_response` unless your harness explicitly overrides classification.

The final result keeps `state`, `response`, and `reason`, and also includes:

- `steps`
- `toolCalls`
- `classifications`
- `retries`
- `controlOutput`
- `stop`
- `elapsedMs`

If the loop times out before any model response is available, `result.response` is `null` and `result.stop` carries the timeout detail.

For deterministic agent stops, `result.reason`, `result.controlOutput`, and `result.stop.controlOutput` line up:

- `final_answer` returns `{ kind: 'final_answer', answer, evidenceRefs }`
- `needs_user_input` returns `{ kind: 'need_user_input', question, reason }`
- `blocked` returns `{ kind: 'blocked', reason }`

### Lifecycle Hooks

Use these additive hooks for tracing and metrics:

- `onIterationStart(...)`
- `onModelResponse(...)`
- `onClassification(...)`
- `onStop(...)`

They do not replace `onTextResponse(...)`, `onToolCallsResponse(...)`, or the other branch callbacks that still own state updates.

### Turn-Loop Hardening

For tool-capable turns, `complete(...)` now applies a package-owned default that keeps unresolved plain text non-terminal before any current-run tool progress and retries twice internally by default. The package default treats unresolved text as missing required evidence, regardless of language. If a host wants the more specific `intent_only_narration` label, it should return that classification explicitly from `classifyTextResponse(...)`.

Use these hooks when your harness needs hardening against weak tool users:

- `requiresActionEvidence(...)` means this turn cannot be considered complete from bare text alone. The package uses it as the central completion contract, while the harness may still tighten or relax that default per turn.
- `classifyTextResponse(...)` lets the harness override package defaults and explicitly classify replies as `verified_final_response`, `intent_only_narration`, or `non_progressing`.
- `onRejectedTextResponse(...)` lets the harness persist rejected narration or other non-progressing text before retrying or stopping.
- `rejectedTextRetryLimit` bounds how many rejected text retries the package should allow before returning `rejected_text_response` instead of false success.

The package-owned completion-loop prompt tells the model that narration is not completion, that read-only inspection can proceed without confirmation, and that announcing an action requires either a tool call in the same assistant turn or continued execution until the action actually happens.

In agent control mode, the package-owned prompt also tells the model to end the run with `final_answer`, `need_user_input`, or `blocked` instead of plain text.

`defaultTextResponseMode` is also available on `runCompletionLoop(...)` for callers that want package-owned unresolved-text handling without switching to the `complete(...)` wrapper.

The package also exports reusable recovery helpers:

- `DEFAULT_COMPLETION_LOOP_SYSTEM_PROMPT`
- `DEFAULT_AGENT_CONTROL_PROTOCOL_VIOLATION_INSTRUCTION`
- `DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION`
- `DEFAULT_NON_PROGRESSING_TEXT_RECOVERY_INSTRUCTION`
- `DEFAULT_TOOL_VALIDATION_RECOVERY_INSTRUCTION`

These are default exported strings, not mutable runtime settings. A harness should treat them as convenient starting points and override the effective recovery text by returning its own `transientInstruction` from `onRejectedTextResponse(...)`, by returning a custom assessment from `classifyTextResponse(...)`, or by supplying its own validation-recovery instruction after parsing a validation artifact.

`onToolCallsResponse(...)` must return `next: { control: 'continue' }` after tool execution when the loop should re-enter the model. If it omits that continuation request, the runtime stops with `tool_calls_response` by design.

When `complete(...)` uses `modelRequest`, `onToolCallsResponse(...)` receives a `toolExecutor` that is already bound to the same effective tool surface as the model request, including per-call `builtIns`, `extraTools`, direct `tools`, MCP config, skill roots, and runtime environment. Use `toolExecutor.executeToolCall(...)` or `toolExecutor.executeToolCalls(...)` in that callback to avoid resolving one tool surface for the model and a different one for execution.

Tool execution helpers throw by default. Agent loops that want recoverable model-readable tool results can pass `errorMode: 'return-artifact'` to return a durable JSON-compatible error artifact for invalid arguments, missing tools, non-executable tools, or execution failures.

Tool validation failures now return durable JSON artifacts instead of opaque error strings. Use `parseToolValidationFailureArtifact(...)` when the harness wants to detect a validation failure from a tool result and prompt the model to emit a corrected tool call.

### Synthetic Tool Calls

When `parsePlainTextToolIntent(...)` converts a text response into a tool-call response, you can opt in to synthetic marking with `markSyntheticToolCalls: true`.

When enabled:

- generated `tool_calls` entries include `synthetic: true`
- mirrored assistant-message tool calls include the same marker
- `result.toolCalls` summaries expose the normalized call source and synthetic status

When disabled, plain-text normalization still works, but the public tool-call surface is unchanged.

The boundary remains the same: the package now owns the default unresolved-text handling for `complete(...)`, while the harness still owns domain-specific acceptance overrides and how bounded recovery should be persisted.

You can provide either:

- `modelRequest` when the package should call `generate(...)` for you
- `callModel` when the harness wants to control model invocation directly

Minimal shape:

```ts
import { complete, createRuntime, type LLMChatMessage } from 'llm-runtime';

type ChatState = {
  messages: LLMChatMessage[];
  finalText: string;
};

const runtime = createRuntime({
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
    },
  },
});

const result = await complete({
  initialState: {
    messages: [{ role: 'user', content: 'Find the token and use tools if needed.' }],
    finalText: '',
  },
  modelRequest: {
    environment: runtime,
    provider: 'openai',
    model: 'gpt-5',
    builtIns: {
      read_file: true,
    },
  },
  buildMessages: async ({ state, transientInstruction }) => {
    if (!transientInstruction) {
      return state.messages;
    }

    return [
      ...state.messages,
      { role: 'system', content: transientInstruction },
    ];
  },
  onToolCallsResponse: async ({ state, response, toolExecutor }) => {
    const nextMessages = [...state.messages, response.assistantMessage];

    for (const toolCall of response.tool_calls ?? []) {
      const toolResult = await toolExecutor?.executeToolCall(
        toolCall,
        { workingDirectory: process.cwd() },
        { errorMode: 'return-artifact' },
      );
      nextMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }

    return {
      state: {
        ...state,
        messages: nextMessages,
      },
      next: {
        control: 'continue',
      },
    };
  },
  onFinalAnswerToolCall: async ({ state, controlOutput }) => ({
    state: {
      ...state,
      finalText: controlOutput.answer,
    },
  }),
  onNeedUserInputToolCall: async ({ state, controlOutput }) => ({
    state: {
      ...state,
      finalText: `${controlOutput.question}\n\n${controlOutput.reason}`,
    },
  }),
  onTextResponse: async ({ state, responseText, response }) => ({
    state: {
      ...state,
      messages: [...state.messages, response.assistantMessage],
      finalText: responseText,
    },
  }),
});

console.log(result.state.finalText);
```

Hardening-oriented shape:

```ts
import {
  DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION,
  DEFAULT_TOOL_VALIDATION_RECOVERY_INSTRUCTION,
  executeToolCall,
  parseToolValidationFailureArtifact,
  runCompletionLoop,
} from 'llm-runtime';

const result = await runCompletionLoop({
  initialState,
  emptyTextRetryLimit: 0,
  rejectedTextRetryLimit: 2,
  requiresActionEvidence: ({ state }) => state.awaitingVerifiedAction,
  buildMessages: async ({ state, transientInstruction }) => {
    if (!transientInstruction) {
      return state.messages;
    }

    return [...state.messages, { role: 'system', content: transientInstruction }];
  },
  onRejectedTextResponse: async ({ state, responseText, classification }) => ({
    state: {
      ...state,
      rejected: [...state.rejected, { classification, responseText }],
    },
    next: {
      control: 'continue',
      transientInstruction: DEFAULT_INTENT_ONLY_NARRATION_RECOVERY_INSTRUCTION,
    },
  }),
  onToolCallsResponse: async ({ state, response }) => {
    const nextMessages = [...state.messages, response.assistantMessage];

    for (const toolCall of response.tool_calls ?? []) {
      const toolResult = await executeToolCall({
        toolCall,
        builtIns: {
          read_file: true,
        },
        errorMode: 'return-artifact',
        context: {
          workingDirectory: process.cwd(),
        },
      });
      const content = JSON.stringify(toolResult);
      const validationArtifact = parseToolValidationFailureArtifact(content);

      nextMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content,
      });

      if (validationArtifact) {
        return {
          state: {
            ...state,
            messages: nextMessages,
          },
          next: {
            control: 'continue',
            transientInstruction: DEFAULT_TOOL_VALIDATION_RECOVERY_INSTRUCTION,
          },
        };
      }
    }

    return {
      state: {
        ...state,
        messages: nextMessages,
      },
      next: {
        control: 'continue',
      },
    };
  },
  onTextResponse: async ({ state, response, responseText }) => ({
    state: {
      ...state,
      messages: [...state.messages, response.assistantMessage],
      finalText: responseText,
      awaitingVerifiedAction: false,
    },
  }),
});
```

## Example

```ts
import { createHumanInputToolResult, createRuntime } from 'llm-runtime';

const runtime = createRuntime({
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
    },
  },
  skillRoots: ['/app/skills', '/workspace/.codex/skills'],
  defaults: {
    reasoningEffort: 'medium',
    toolPermission: 'auto',
  },
  mcpConfig: {
    servers: {
      docs: {
        command: 'node',
        args: ['docs-server.js'],
        transport: 'stdio',
      },
    },
  },
});

const response = await runtime.generate({
  provider: 'openai',
  model: 'gpt-5',
  messages: [
    {
      role: 'user',
      content: 'Summarize the workspace and use tools when needed.',
    },
  ],
  workingDirectory: process.cwd(),
  builtIns: {
    read_file: true,
    list_files: true,
    load_skill: true,
  },
});

console.log(response.content);

const completion = await runtime.complete({
  provider: 'openai',
  model: 'gpt-5',
  messages: [
    {
      role: 'user',
      content: 'Find the token and use tools if needed.',
    },
  ],
  builtIns: {
    ask_user_input: true,
    read_file: true,
    search_files: true,
  },
});

if (completion.status === 'completed') {
  console.log(completion.output);
}

if (completion.status === 'waiting_for_human') {
  console.log(completion.pendingHumanInput.request);

  const resumed = await runtime.complete({
    provider: 'openai',
    model: 'gpt-5',
    messages: [
      ...completion.messages,
      createHumanInputToolResult(completion.pendingHumanInput, {
        answers: {
          scope: 'all',
        },
      }),
    ],
    builtIns: {
      ask_user_input: true,
      read_file: true,
      search_files: true,
    },
  });

  if (resumed.status === 'completed') {
    console.log(resumed.output);
  }
}

for await (const event of runtime.streamComplete({
  provider: 'openai',
  model: 'gpt-5',
  messages: [
    {
      role: 'user',
      content: 'Continue with streaming agent events.',
    },
  ],
  builtIns: {
    read_file: true,
  },
})) {
  if (event.type === 'completed') {
    console.log(event.result.output);
  }
}
```

## Harness Guidance

Recommended integration pattern:

1. Create one stable `runtime` for the harness.
2. Pass request-specific inputs per call.
3. Inspect `runtime.skillRegistry` and `runtime.mcpRegistry` when you need to debug discovered skills or MCP servers.
4. Update skill roots when the harness-level skill search path changes.
5. Do not rebuild the runtime just because request-local values like `messages` or `workingDirectory` changed.

Example registry inspection pattern:

```ts
import { createRuntime } from 'llm-runtime';

const runtime = createRuntime();

const skills = await runtime.skillRegistry.listSkills();
const servers = runtime.mcpRegistry.listServers();

console.table(skills.map((skill) => ({
  skillId: skill.skillId,
  title: skill.title,
})));

console.table(servers.map((server) => ({
  name: server.name,
  transport: server.config.transport,
})));
```

## Local Development

- `npm run build` compiles the package into `dist/`
- `npm run check` runs TypeScript without emitting files
- `npm test` runs the Vitest suite in `tests/llm`
- `npm run test:watch` runs the Vitest suite in watch mode
- `npm run test:e2e` runs the showcase script in `tests/e2e/llm-package-showcase.ts`
- `npm run test:e2e:dry-run` validates the showcase wiring without live provider calls
- `npm run test:e2e:turn-loop` runs the `complete(...)` showcase script in `tests/e2e/llm-turn-loop-showcase.ts`
- `npm run test:e2e:turn-loop:dry-run` validates the turn-loop showcase wiring without live provider calls
- `npm run test:e2e:hardening` runs deterministic end-to-end hardening coverage for narrated intent recovery and validation-failure correction without a live provider

Use `npm run test:e2e:hardening` for package-level regression coverage of turn-loop hardening. Use the showcase runners when you want to validate live provider integration and real tool-calling behavior.

The real showcase runners expect a repo-local `.env` file when using `npm run test:e2e` or `npm run test:e2e:turn-loop`.
