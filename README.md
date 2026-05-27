# `llm-runtime`

`llm-runtime` is a TypeScript runtime layer for application-owned LLM workflows. It gives a host app one package boundary for provider calls, tool execution, MCP discovery, skills, and bounded agentic completion.

The package is intentionally not a full agent product. Your app still owns UI, persistence, permissions, transcript storage, workspace lifetime, and business policy. `llm-runtime` owns the provider/tool loop mechanics that should not be reimplemented in every harness.

For a human-oriented walkthrough of the codebase, start with the local project wiki: [.wiki/index.md](.wiki/index.md).

## Installation

```bash
npm install llm-runtime
```

The package is ESM-only, targets Node.js 18+, and exposes a single root entrypoint.

## Public Surface

The root entrypoint exports four runtime functions:

- `generate(...)`
- `complete(...)`
- `streamComplete(...)`
- `createRuntime(...)`

It also exports the public type set for providers, messages, tools, runtime options, completion results, stream events, MCP config, and provider config.

Lower-level loop internals, direct provider clients, recovery prompts, validation helpers, and tool-resolution helpers are not part of the root public API. If an app needs stable reusable dependencies and tool execution helpers, create a runtime and use the methods on that runtime instance.

## Providers

Supported provider names:

- `openai`
- `anthropic`
- `google`
- `azure`
- `xai`
- `openai-compatible`
- `ollama`

Provider configuration can be passed per call, through a provider map, or through a reusable runtime:

```ts
import { generate } from 'llm-runtime';

const response = await generate({
  provider: 'openai',
  model: 'gpt-5',
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
    },
  },
  messages: [
    { role: 'user', content: 'Summarize this in one paragraph.' },
  ],
});

console.log(response.content);
```

## Runtime Model

Use `createRuntime(...)` when your app wants stable provider config, MCP config, skill roots, defaults, and registry state across many calls.

Put stable harness state in the runtime:

- provider config
- MCP config or MCP registry
- skill roots or skill registry
- default `reasoningEffort`
- default `toolPermission`

Keep request-local state per call:

- `provider`
- `model`
- `messages`
- `temperature`
- `maxTokens`
- `context.workingDirectory`
- `context.abortSignal`
- `webSearch`
- per-call `builtIns`, `extraTools`, or `tools`

## Single-Turn Generation

`generate(...)` performs one provider call. It resolves the requested tool surface and passes it to the provider, but it does not execute returned tool calls or continue the conversation. Use it when the host wants to own the loop.

The returned `LLMResponse` is either:

- `type: 'text'` with `content`
- `type: 'tool_calls'` with `tool_calls`

Use `complete(...)` when the runtime should own repeated model calls, tool execution, and terminal control-tool handling.

Example:

```ts
import { createRuntime } from 'llm-runtime';

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
    { role: 'user', content: 'Read the project and identify the main runtime boundary.' },
  ],
  context: {
    workingDirectory: process.cwd(),
  },
  builtIns: {
    read_file: true,
    list_files: true,
    search_files: true,
  },
});

console.log(response.content);

await runtime.dispose();
```

## Completion

`complete(...)` owns a bounded model/tool loop. It retries weak non-progressing responses, executes known tools, injects the runtime completion contract, and terminates through internal control tools:

- `final_answer`
- `need_user_input`
- `blocked`

Those control tools are runtime-reserved. Do not define app tools with those names.

`complete(...)` returns:

- `status: 'completed'` with `output` when the model reaches `final_answer`
- `status: 'tool_calls'` when the host must handle a tool call, commonly required user input
- `status: 'failed'` when the run is blocked, invalid, or otherwise cannot complete
- `status: 'max_iterations'` when loop bounds stop the run

Example:

```ts
import { createRuntime } from 'llm-runtime';

const runtime = createRuntime({
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
    },
  },
});

const result = await runtime.complete({
  provider: 'openai',
  model: 'gpt-5',
  messages: [
    { role: 'user', content: 'Inspect the workspace and tell me where runtime completion is implemented.' },
  ],
  context: {
    workingDirectory: process.cwd(),
  },
  builtIns: {
    read_file: true,
    search_files: true,
    path_exists: true,
  },
  maxIterations: 12,
});

if (result.status === 'completed') {
  console.log(result.output);
}

if (result.status === 'tool_calls') {
  console.log(result.toolCalls);
}
```

`streamComplete(...)` runs the same completion path and yields lifecycle events. It emits model/tool events plus provider text and reasoning deltas when the provider adapter supplies them:

- `model_start`
- `text_delta`
- `reasoning_delta`
- `assistant_message`
- `tool_start`
- `tool_result`
- `tool_error`
- `tool_calls`
- `completed`
- `failed`
- `raw`

```ts
for await (const event of runtime.streamComplete({
  provider: 'openai',
  model: 'gpt-5',
  messages: [
    { role: 'user', content: 'Use tools if needed, then give the final answer.' },
  ],
  builtIns: 'read-only',
})) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  }

  if (event.type === 'completed') {
    console.log(event.result.output);
  }
}
```

## Tools

Tool sources are merged into one model-facing surface:

- built-in runtime tools
- app-provided `extraTools`
- app-provided `tools`
- MCP tools discovered from configured servers

Built-in tool names are reserved:

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

Default built-ins differ by call shape:

- `generate(...)` defaults to the read-only built-ins: `load_skill`, `read_file`, `list_files`, `search_files`, `path_exists`
- `complete(...)` and `streamComplete(...)` default to the same read-only set plus model-visible `ask_user_input`
- write-capable or external-action built-ins require explicit opt-in with `builtIns: true`, `builtIns: 'all'`, or a per-tool map
- `builtIns: false` disables all built-ins for that call

Prefer structured workspace tools over `shell_cmd` for routine file work:

- `list_files` for directory listing
- `search_files` for glob-like discovery
- `read_file` for paginated file reads
- `path_exists` for file or directory checks
- `create_directory` for recursive directory creation when enabled

App tools can be passed as `extraTools` or `tools`. They are additive; they cannot override reserved built-ins or completion control tools.

```ts
const result = await runtime.complete({
  provider: 'openai',
  model: 'gpt-5',
  messages: [
    { role: 'user', content: 'Look up customer c_123 and summarize the account state.' },
  ],
  extraTools: [
    {
      name: 'lookup_customer',
      description: 'Look up a customer by id.',
      evidenceKind: 'read',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
        },
        required: ['customerId'],
        additionalProperties: false,
      },
      execute: async ({ customerId }) => {
        return { customerId, plan: 'enterprise', status: 'active' };
      },
    },
  ],
});
```

Runtime instances also expose `resolveTools(...)`, `executeToolCall(...)`, and `executeToolCalls(...)` for hosts that need to inspect or run the effective tool surface outside `complete(...)`.

## Human Input

`ask_user_input` is the public human-input tool contract. It uses a structured `questions[]` payload:

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

When completion needs host-owned user input, it returns `status: 'tool_calls'`. The host should surface the question, then resume by appending a normal tool-result message for the pending tool call and calling `complete(...)` again with the updated message list.

```ts
const resumedMessages = [
  ...result.messages,
  {
    role: 'tool',
    tool_call_id: result.toolCalls![0].id,
    content: JSON.stringify({
      answers: {
        scope: 'all',
      },
    }),
  },
];
```

## MCP And Skills

MCP servers are configured through `mcpConfig`. Both `servers` and legacy `mcpServers` shapes are accepted. URL-based servers default to `streamable-http`; stdio servers require a command.

```ts
const runtime = createRuntime({
  mcpConfig: {
    servers: {
      search: {
        url: 'https://example.com/mcp',
        headers: {
          Authorization: `Bearer ${process.env.MCP_TOKEN}`,
        },
      },
    },
  },
});
```

Skills are discovered from configured `skillRoots` and loaded through the `load_skill` built-in. Later skill roots have higher precedence when duplicate skill ids are found.

Skills add instruction context. They are not executable tools.

## Web Search

Pass `webSearch` per call:

```ts
const response = await generate({
  provider: 'openai',
  model: 'gpt-5',
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
    },
  },
  messages: [
    { role: 'user', content: 'Use current public information to answer.' },
  ],
  webSearch: {
    searchContextSize: 'medium',
  },
});
```

Provider behavior:

- `openai`, `anthropic`, and `google` receive provider-native web search options
- `azure`, `openai-compatible`, `xai`, and `ollama` ignore unsupported web search on the current chat path and return a `web_search_ignored` warning
- Gemini Google Search grounding is not combined with function calling; when both tools and `webSearch` are requested for `google`, tools win and web search is ignored with a warning
- `searchContextSize` is forwarded for OpenAI-style requests and ignored by Anthropic and Gemini

## Cleanup

Call `runtime.dispose()` when a runtime owns MCP clients:

```ts
const runtime = createRuntime({ mcpConfig });

try {
  await runtime.complete(request);
} finally {
  await runtime.dispose();
}
```

The host still owns temporary workspaces, transcript persistence, app-specific registries, and any resources it injected into the runtime.

## Local Development

```bash
npm run build
npm run check
npm test
```

Useful scripts:

- `npm run build` compiles `src/` into `dist/`
- `npm run check` runs TypeScript without emitting files
- `npm test` runs the Vitest suite in `tests/llm`
- `npm run test:watch` runs Vitest in watch mode
- `npm run test:e2e` runs the live provider showcase
- `npm run test:e2e:dry-run` validates showcase wiring without live provider calls
- `npm run test:e2e:azure` runs Azure live-provider coverage
- `npm run test:e2e:azure:dry-run` validates Azure showcase wiring
- `npm run test:e2e:gemini` runs Gemini live-provider coverage
- `npm run test:e2e:gemini:dry-run` validates Gemini showcase wiring
- `npm run test:e2e:turn-loop` runs runtime completion showcase coverage
- `npm run test:e2e:turn-loop:dry-run` validates turn-loop showcase wiring
- `npm run test:e2e:hardening` runs deterministic hardening coverage without a live provider

Live showcase runners expect a repo-local `.env` with the relevant provider credentials.
