---
title: "System Prompt Schema"
type: "concept"
status: "active"
language: "default"
source_paths:
  - "src/prompt-contracts.ts"
  - "src/runtime.ts"
  - "src/openai-direct.ts"
  - "src/anthropic-direct.ts"
  - "src/google-direct.ts"
  - "tests/llm/runtime.test.ts"
  - "tests/llm/runtime-provider.test.ts"
updated_at: "2026-05-14"
---

This page explains the safest way to build the first system message before calling `generate(...)` or `stream(...)`.

In plain terms, put your app's rules, any repository instructions from `AGENTS.md`, and your own tool-use preferences into one combined system message, then let the runtime append its own package-managed guidance after that.

Facts from source:
- `src/runtime.ts` does not have a special AGENTS.md field. The caller is responsible for turning any client system prompt, AGENTS.md content, and custom tool policy into normal chat `messages`.
- `src/runtime.ts` appends runtime-owned guidance onto the first existing `system` message when one exists, or creates a new leading `system` message when none exists.
- The runtime-managed content is wrapped in a tagged block from `src/prompt-contracts.ts`, so repeated injections replace the package-owned section instead of stacking duplicate guidance.
- The runtime can inject up to three managed sections depending on the surface: the agent run-loop contract used by completion helpers, the `ask_user_input` hint, and the structured workspace-tool hint (`list_files`, `search_files`, `read_file`, `path_exists`, `create_directory`).
- `src/openai-direct.ts` preserves `system` messages as ordinary system-role entries.
- `src/anthropic-direct.ts` extracts only the first `system` message into Anthropic's top-level `system` field.
- `src/google-direct.ts` overwrites `systemInstruction` as it iterates, so the last `system` message wins.

Recommended schema:

1. One combined `system` message assembled by the caller.
2. Inside that message, use explicit sections in this order:
   - Client instructions
   - AGENTS.md content
   - Client-owned tool policy
3. After that combined system block, include the normal `user` / `assistant` / `tool` transcript.
4. Let the runtime append its own tool guidance after the caller-owned sections.

What the runtime adds today:
- `generate(...)` and `stream(...)` can append the human-input hint and workspace-tool hint when those tools are enabled.
- `complete(...)` and `runtime.complete(...)` also append the agent run-loop contract so the model is reminded that narration is not completion.
- The managed block is inserted into the same first system message rather than as a separate transport field, which keeps cross-provider behavior stable.

Suggested section layout:

```text
[Client Instructions]
...application-level behavior, product rules, and response expectations...

[AGENTS.md]
...repo-specific engineering rules, workflow constraints, and coding guidance...

[Tool Policy]
...caller-owned preference rules such as when to use structured workspace tools versus shell_cmd...
```

Keep the caller-owned tool policy short. The runtime already appends its own tool hint, so the caller section should usually stay to 3-6 lines.

Concise tool-policy example:
- Prefer `list_files`, `search_files`, `read_file`, `path_exists`, and `create_directory` for normal workspace exploration.
- Use `shell_cmd` only for explicit commands, git workflows, or gaps in the structured tools.
- With `shell_cmd`, send one command plus `parameters`, not a pipeline string.
- Preferred shell patterns: `rg --files`, `rg "pattern"`, `find`, `sed -n "1,200p" path`, `head -n 200 path`, `tail -n 100 path`.
- Prefer `rg` over `grep`, and `head` or `sed -n` over `cat` for bounded reads.

After injection, the effective system prompt becomes:

```text
[Client Instructions]
...

[AGENTS.md]
...

[Tool Policy]
Prefer structured workspace tools first.
Use `shell_cmd` only for explicit commands, git, or gaps.
With `shell_cmd`, send one command plus `parameters`.

[Example Shell Fallback Recipes]
- `command: "rg"`, `parameters: ["--files"]`
- `command: "rg"`, `parameters: ["pattern"]`
- `command: "find"`, `parameters: ["src", "-name", "*.ts"]`
- `command: "sed"`, `parameters: ["-n", "1,200p", "src/runtime.ts"]`
- `command: "head"`, `parameters: ["-n", "200", "src/runtime.ts"]`
- `command: "tail"`, `parameters: ["-n", "100", "src/runtime.ts"]`

[Runtime Tool Guidance]
...human-input guidance when HITL tools are enabled...
...workspace-tool guidance when structured workspace tools are enabled...
```

Why one system block is the stable schema:
- OpenAI-compatible providers can carry multiple system messages without collapsing them, but that does not guarantee consistent behavior across other providers.
- Anthropic only reads the first system message, so a second caller-supplied system message can be ignored.
- Gemini effectively keeps the last system message, so earlier caller-supplied system content can be overwritten.
- A single combined system message avoids provider-specific drift and still lets the runtime append package-owned guidance deterministically.

Practical rule:
- Treat AGENTS.md as caller-owned content that should be embedded into the first system message, not as a separate transport field.
- Add caller-owned tool policy immediately after the AGENTS.md section so runtime-injected guidance reads as a lower-priority package supplement.
- If the caller includes shell examples, keep them short, recipe-style, and aligned with `rg`, `find`, `head`, `tail`, and `sed -n` rather than open-ended shell pipelines.
- Avoid sending multiple independent system messages unless the caller is intentionally accepting cross-provider differences.

Read this with [[src-runtime]] for the injection path, with [[src-prompt-contracts]] for the reusable managed-block helpers, and with [[provider-adapters]] for the provider-specific message normalization differences.