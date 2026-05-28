---
title: "Project Wiki"
type: "index"
status: "active"
language: "default"
last_commit: "a6efd8d1ced45f9fd81cf2006644595a78fd4853"
updated_at: "2026-05-28"
---

## What is this?

`llm-runtime` is a TypeScript package for application-owned LLM workflows. It wraps provider calls, tool execution, MCP discovery, skills, and bounded agentic completion behind one package boundary without taking over the host app's state, persistence, UI, permissions, workspace lifetime, or business policy.

## Get started

Run `npm test` for the unit suite and `npm run check` for TypeScript. The package is ESM-only, targets Node.js 18+, and publishes a single root entrypoint.

Expected success is a passing Vitest suite under `tests/llm` and a clean `tsc --noEmit`. Start with `README.md`, then read [[environment-vs-per-call]], [[src-runtime]], [[src-completion-loop]], [[src-builtins]], and [[public-types]].

A safe first change is a focused built-in tool contract test in `tests/llm/runtime.test.ts`. A tempting dangerous change is making runtime completion own host concerns such as prompt UI, transcript persistence, human-input waiting, or broad shell policy.

## Why does it exist?

Harnesses need stable per-call APIs without duplicating provider-specific request shaping, tool schema wiring, MCP setup, skill loading, and loop hardening. The package centralizes those mechanics while keeping app-specific decisions in the host.

The core ownership rule is [[environment-vs-per-call]]: stable dependencies can live in the runtime, while request-specific choices stay per call.

## What happens when I run it?

The root package entrypoint is deliberately small: `generate(...)`, `complete(...)`, `streamComplete(...)`, and `createRuntime(...)`. `generate(...)` performs one provider call and may return text or tool calls. `complete(...)`, `streamComplete(...)`, `runtime.complete(...)`, and `runtime.streamComplete(...)` add the bounded runtime-owned model/tool loop and terminate through control tools. `streamComplete(...)` can now surface streamed provider text, reasoning, raw tool-call argument deltas, and parsed `final_answer` answer deltas. Lower-level loop machinery still exists internally, but it is no longer root public API. See [[generate-vs-complete]], [[src-runtime]], [[src-completion-loop]], and [[public-types]].

If the model calls default `ask_user_input`, runtime completion stops with `status: "tool_calls"` and returns the call to the host. The host owns whether to pause, render a prompt, wait, time out, cancel, or resume. See [[host-owned-ask-user-input]] and [[src-runtime-complete-contract]].

## Where is data saved?

The package itself does not own durable storage. It may cache provider stores, MCP registries, and skill registries for convenience-path calls, and explicit runtimes own cleanup for runtime-created MCP registries. The host owns transcripts, workspaces, human answers, temp files, product records, and caller-injected registries.

## What are the important moving parts?

- [[src-runtime]] is the main API facade.
- [[src-completion-loop]] is the bounded iterative loop.
- [[generate-vs-complete]] explains the one-call versus runtime-owned-loop contract.
- [[src-builtins]] and [[src-builtin-executors]] define and execute reserved package tools.
- [[src-tool-validation]] turns malformed tool arguments into structured artifacts.
- [[src-mcp]], [[src-skills]], and [[provider-adapters]] wire external capability surfaces.
- [[system-prompt-schema]] and [[src-prompt-contracts]] explain managed system-message injection.

## What should I avoid breaking?

- Do not blur package-owned orchestration with host-owned UI, persistence, or policy.
- Do not make `ask_user_input` a runtime wait state or fake executor again; keep it model-visible and host-owned.
- Do not weaken the trusted working-directory boundary for structured file tools.
- Do not treat human-input artifacts as action evidence for task completion.
- Do not make `builtIns` control whether completion can loop; built-ins are only one tool source.
- Do not make provider-specific tool names leak into the public tool-call surface.

Risk pages: [[shell-command-safeguards]], [[turn-loop-safety-and-lifecycle]], [[approval-and-synthetic-tool-call-messages]], [[host-owned-ask-user-input]], and [[file-tool-contract-hardening]].

## Where do I look first?

For a public API question, start at [[public-types]] and [[src-runtime]]. For `generate(...)` versus `complete(...)`, start at [[generate-vs-complete]]. For loop behavior, start at [[src-completion-loop]]. For tool behavior, start at [[src-builtins]], [[src-builtin-executors]], and [[src-tool-validation]]. For recent contract changes, read [[host-owned-ask-user-input]] and [[file-tool-contract-hardening]].

Coverage note: the last full ingest checkpoint is commit `a6efd8d1ced45f9fd81cf2006644595a78fd4853`. Current wiki notes also document the `generate(...)` versus `complete(...)` contract, control-tool runtime completion, host-owned `ask_user_input`, default-all built-ins with explicit disable/narrowing, and the rule that built-ins affect tool availability rather than loop ownership.
