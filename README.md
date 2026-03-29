# `@agent-world/llm`

`@agent-world/llm` is a runtime layer for application-owned LLM workflows. It wraps provider invocation with one package boundary for tool orchestration, MCP integration, and skill loading.

This package is designed for harnesses that want a stable per-call API without pushing provider-specific details, built-in tool contracts, MCP wiring, and skill discovery into application code.

## What This Package Owns

- Provider dispatch for `generate(...)` and `stream(...)`
- Built-in tools such as file access, shell execution, and skill loading
- MCP tool discovery and execution
- Skill discovery from configured skill roots
- Effective tool-surface resolution through `resolveTools(...)` and `resolveToolsAsync(...)`

## Public API

- `createLLMEnvironment(...)`
- `generate(...)`
- `stream(...)`
- `resolveTools(...)`
- `resolveToolsAsync(...)`

The package is per-call first. You can call `generate(...)` or `stream(...)` directly, or inject an explicit `environment` when your harness wants stable provider, MCP, and skill dependencies.

## Mental Model

The main rule is simple:

- Stable harness state belongs in `environment`
- Request-specific state stays per call

### Put This In `environment`

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
- `abortSignal`

If a value should change from one request or UI action to the next, it usually should not live in the environment.

## Tool Model

`@agent-world/llm` merges several tool sources into one callable surface.

### Built-In Tools

The package currently reserves these built-in names:

- `shell_cmd`
- `load_skill`
- `human_intervention_request`
- `web_fetch`
- `read_file`
- `write_file`
- `list_files`
- `grep`

Built-ins are package-owned. Application code can disable or narrow them, but should not redefine them.

### Extra Tools

Extra tools are application-specific additions such as `lookup_customer` or `create_ticket`. They are additive only and cannot override reserved built-in names.

### MCP Tools

MCP tools come from configured external servers. The runtime discovers them, namespaces them, and merges them into the same resolved tool set as built-ins and extra tools.

### Skills

Skills are reusable instruction assets discovered from skill roots and loaded through `load_skill`. Skills are not executable tools; they add instruction context for the model.

## `generate(...)` vs `stream(...)`

Both APIs share the same runtime model:

- same provider config shape
- same tool orchestration
- same MCP and skill semantics

The difference is output delivery:

- `generate(...)` returns the final result
- `stream(...)` emits chunks and still returns the final result at the end

## Example

```ts
import { createLLMEnvironment, generate } from '@agent-world/llm';

const environment = createLLMEnvironment({
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

const response = await generate({
  environment,
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
```

## Harness Guidance

Recommended integration pattern:

1. Create one stable `environment` for the harness.
2. Pass request-specific inputs per call.
3. Use `resolveToolsAsync(...)` when you need to inspect the effective callable tool surface before execution.
4. Update skill roots when the harness-level skill search path changes.
5. Do not rebuild the environment just because request-local values like `messages` or `workingDirectory` changed.

## Local Development

- `npm run build` compiles the package into `dist/`
- `npm run check` runs TypeScript without emitting files
- `npm test` runs the Vitest suite in `tests/llm`
- `npm run test:watch` runs the Vitest suite in watch mode
- `npm run test:e2e` runs the showcase script in `tests/e2e/llm-package-showcase.ts`
- `npm run test:e2e:dry-run` validates the showcase wiring without live provider calls

The real showcase runner expects a repo-local `.env` file when using `npm run test:e2e`.
