# `llm-runtime` Developer Training


## Session Outcomes

By the end of the session, developers should be able to:
- explain the difference between `environment` and per-call inputs
- map stable harness state and request-specific state into one `generate(...)` or `stream(...)` call
- explain how built-ins, MCP tools, extra tools, and skills differ
- use `resolveToolsAsync(...)` to inspect the effective tool surface
- know when to update skill roots and when not to rebuild the environment

---

## 1-Hour Workshop Agenda

### 0:00-0:05 Intro and Goals

- Why `llm-runtime` exists
- Why the package is more than a raw provider SDK
- What developers should be able to do after the session

### 0:05-0:12 Package Mental Model

- `generate(...)` vs `stream(...)`
- per-call API with optional explicit `environment`
- what the package owns:
  - provider dispatch
  - built-in tools
  - MCP integration
  - skill loading

### 0:12-0:20 Harness and Request Mapping

- the harness owns `environment`
- per-call inputs select `provider` and `model`
- request or UI inputs provide:
  - `messages`
  - `workingDirectory`
  - `reasoningEffort`
  - `toolPermission`
- when to update skill roots

### 0:20-0:30 Tool Calling Basics

- what a tool call is
- built-in tools vs extra tools
- reserved built-in names
- how tool results feed back into the model loop

### 0:30-0:38 MCP and Skills

- what MCP adds
- how MCP config becomes executable tools
- what skills are
- how `load_skill` differs from a tool executor

### 0:38-0:48 API Walkthrough

- `createLLMEnvironment(...)`
- `generate(...)`
- `stream(...)`
- `resolveTools(...)` / `resolveToolsAsync(...)`
- concrete harness usage pattern

### 0:48-0:55 Demo / Code Walkthrough

- create one harness environment
- run one `generate(...)`
- run one `stream(...)`
- show one built-in, one skill, and one MCP tool

### 0:55-1:00 Q&A and Recap

- recap rules
- common mistakes
- suggested adoption pattern for application code

---

## Presentation Outline

### Slide 1: Title

- Training: `llm-runtime`
- Per-call runtime, tools, MCP, and skills

**Speaker notes**

This session is about how to use the package as an application runtime layer, not as a low-level model SDK. The goal is to make the integration model obvious and stable for any custom harness.

### Slide 2: Why This Package Exists

- raw provider SDKs solve only model invocation
- real apps also need tools, MCP, and skills
- `llm-runtime` gives one package boundary for that runtime logic

**Speaker notes**

Emphasize that this package exists so application code does not need to own provider-format details, built-in tool contracts, MCP orchestration, and skill loading independently.

### Slide 3: What the Package Owns

- provider dispatch
- built-in tools
- MCP tool discovery and execution
- skill loading
- `generate(...)`, `stream(...)`, and tool resolution

**Speaker notes**

This is the package boundary. If a developer asks whether something belongs in their harness or in `llm-runtime`, start by checking whether it is part of model orchestration, tool orchestration, MCP orchestration, or skill loading.

### Slide 4: Public API

- `createLLMEnvironment(...)`
- `generate(...)`
- `stream(...)`
- `resolveTools(...)`
- `resolveToolsAsync(...)`

**Speaker notes**

Keep the entrypoints short and memorable. Developers should not think in terms of class lifecycles here. The package is per-call first, with optional explicit environment injection.

### Slide 5: Convenience Path vs Explicit Environment

- no `environment`:
  - package builds and uses internal cached dependencies
- with `environment`:
  - package uses only injected provider, MCP, and skill dependencies

**Speaker notes**

This is the most important behavior rule in the package. It explains both the simple path and the explicit path without forcing two different APIs.

### Slide 6: Runtime Mental Model

- input messages go in
- runtime resolves callable tools
- model returns text or tool calls
- tools execute
- tool results continue the turn

**Speaker notes**

This is the backbone of the runtime. Tool calling is not a side feature. It is the normal loop for non-trivial assistant workflows.

### Slide 7: `generate(...)` vs `stream(...)`

- same config model
- same orchestration path
- different delivery mode
- `generate(...)` returns final result
- `stream(...)` emits chunks and still returns the final result

**Speaker notes**

Developers should not think these are separate systems. They differ mainly in output delivery, not in tool, MCP, or skill semantics.

### Slide 8: What Goes in the Environment

- provider config store
- MCP registry
- skill registry
- default reasoning and permission fallback

**Speaker notes**

Environment is for stable dependencies and stable fallback policy. If changing a value should mean “this is a different harness-level runtime environment,” it belongs here.

### Slide 9: What Stays Per Call

- `provider`
- `model`
- `messages`
- `workingDirectory`
- `reasoningEffort`
- `toolPermission`
- `abortSignal`

**Speaker notes**

Per-call state is request-local. If a caller, request handler, session, or UI flow can change it from one request to the next, it should generally stay out of the environment.

### Slide 10: Harness and Request Mapping

- the harness owns `environment`
- per-call inputs choose `provider` and `model`
- request or UI inputs provide:
  - `messages`
  - `workingDirectory`
  - `reasoningEffort`
  - `toolPermission`

**Speaker notes**

This is the recommended ownership rule for a generic integration. Keep one stable environment for the harness, and let request-specific execution data vary per call.

### Slide 11: Built-In Tools

- `shell_cmd`
- `load_skill`
- `human_intervention_request`
- `web_fetch`
- `read_file`
- `write_file`
- `list_files`
- `grep`

**Speaker notes**

These are package-owned capabilities. Application code can disable them or add extra tools, but should not redefine them.

### Slide 12: Extra Tools

- application-specific capabilities live here
- additive only
- cannot override reserved built-in names
- example:
  - `lookup_customer`
  - `create_ticket`

**Speaker notes**

This is where harness-specific behavior belongs. The package owns canonical built-ins; the application owns extension tools with new names.

### Slide 13: Tool Calling Lifecycle

- tool schema exposed to the model
- model emits a tool call request
- runtime validates and executes tool
- tool result is added back to the loop
- model continues with updated context

**Speaker notes**

Make sure developers understand that the runtime, not the application, is responsible for making this loop coherent and repeatable.

### Slide 14: MCP Basics

- MCP exposes tools from external servers
- runtime connects to configured servers
- runtime discovers and namespaces tools
- MCP tools merge into the same callable tool set

**Speaker notes**

MCP tools behave like first-class tools once resolved. The important difference is where they come from and how they are discovered.

### Slide 15: Skill Basics

- skill = reusable instruction asset
- discovered from skill roots
- loaded via `load_skill`
- skills are not executable tools

**Speaker notes**

This distinction matters. Skills change model context. Tools perform actions. Developers often blur them; the training should make the difference explicit.

### Slide 16: Skills vs Tools vs MCP

- skill:
  - reusable instructions
- built-in tool:
  - local package-owned capability
- MCP tool:
  - externally hosted capability
- extra tool:
  - application-owned extension

**Speaker notes**

This slide is the vocabulary slide. If developers remember only one taxonomy, it should be this one.

### Slide 17: Skill Root Updates

- skill registry lives in the harness environment
- changing `context.workingDirectory` does not automatically change skill roots
- update skill roots when the effective project or content root changes
- do not rebuild the whole environment for every request

**Speaker notes**

This is the operational rule developers need in a generic harness. A cwd change in the UI or request context is not always a skill-root change. Only meaningful root changes should update skill roots.

### Slide 18: Generic Harness Usage Pattern

```ts
const environment = createLLMEnvironment({
  providers,
  mcpConfig,
  skillRoots,
});

const response = await generate({
  environment,
  provider: request.provider ?? defaultProvider,
  model: request.model ?? defaultModel,
  messages: request.messages,
  context: {
    workingDirectory: request.workingDirectory,
    reasoningEffort: request.reasoningEffort,
    toolPermission: request.toolPermission,
    abortSignal,
  },
});
```

**Speaker notes**

This is the canonical example to anchor the rest of the training. Everything else should map back to this structure.

### Slide 19: Debugging Tips

- inspect `resolveToolsAsync(...)` to see the effective tool surface
- verify provider and model resolution before blaming the runtime
- check skill roots if `load_skill` is not finding expected content
- check MCP config and transport if MCP tools are missing

**Speaker notes**

Give developers a short checklist. Most confusion will come from wrong provider or model selection, wrong skill roots, or missing MCP discovery.

### Slide 20: Common Mistakes

- treating request or session state as the environment owner
- rebuilding environment every call
- expecting `workingDirectory` to auto-refresh skill roots
- trying to override built-in tool names
- treating skills like executable tools

**Speaker notes**

Call out the failure modes directly. These are the design mistakes most likely to create drift or confusion in an application harness.

### Slide 21: Testing Guidance

- unit tests:
  - mock provider calls
  - use explicit environment where helpful
- integration or e2e tests:
  - exercise MCP and the tool loop
  - keep live provider usage intentional and limited

**Speaker notes**

Developers should know the package supports both fast deterministic unit coverage and higher-level showcase or end-to-end validation.

### Slide 22: Summary

- `llm-runtime` is a runtime layer
- the harness owns environment
- per-call inputs choose provider and model
- request-local state drives execution context
- tools, MCP, and skills are first-class runtime concepts

**Speaker notes**

End on the ownership model and the package boundary. That is the main conceptual takeaway for developers integrating this package into their own harness.

---

## Demo Plan

### Demo 1: Inspect the Effective Tool Surface

- show `resolveToolsAsync(...)`
- point out built-ins, MCP tools, and naming

### Demo 2: Run `generate(...)`

- one harness-level environment
- one per-call provider and model selection
- one request-level `workingDirectory`, reasoning, and permission set

### Demo 3: Run `stream(...)`

- same inputs
- different output mode
- show chunk handling

### Demo 4: Show Skill and MCP Interaction

- `load_skill`
- one MCP lookup tool
- final response composed from both

---

## Suggested Q&A Topics

- Why environment belongs to the harness, not the request
- When to rebuild vs reuse environment
- How to handle multiple harness instances in memory
- How MCP caching behaves
- How skill roots should react to cwd changes
- When to use extra tools instead of MCP

---

## Trainer Notes

- Keep repeating the same ownership rule:
  - harness = environment
  - per-call inputs = provider and model choice
  - request = execution context and messages
- Do not let the session drift into low-level provider SDK details.
- Emphasize that tool calling is the standard execution model, not an edge case.
- Emphasize that skills are context assets, not tool executors.
- Use the explicit environment example as the default recommendation for application integrations.
