---
title: "Project Wiki"
type: "index"
status: "active"
language: "default"
last_commit: "340f35e37d5263e09be8f7f9414e5995c9029374"
updated_at: "2026-05-27"
---

## What is this?

`llm-runtime` is a TypeScript package for application-owned LLM workflows. It wraps provider invocation, tool orchestration, MCP discovery, and skill loading behind one package boundary without taking over the host app's state, persistence, UI, or product policy.

## Get started

Run `npm test` for the unit suite and `npm run check` for TypeScript. The package targets Node.js 18+ and publishes a single root entrypoint.

Expected success is a passing Vitest suite under `tests/llm` and a clean `tsc --noEmit`. Start with `README.md`, then read [[environment-vs-per-call]], [[src-runtime]], [[src-completion-loop]], [[src-builtins]], and [[public-types]].

A safe first change is a focused built-in tool contract test in `tests/llm/runtime.test.ts`. A tempting dangerous change is making runtime completion own host concerns such as prompt UI, transcript persistence, human-input waiting, or broad shell policy.

## Why does it exist?

Harnesses need stable per-call APIs without duplicating provider-specific request shaping, tool schema wiring, MCP setup, skill loading, and loop hardening. The package centralizes those mechanics while keeping app-specific decisions in the host.

The core ownership rule is [[environment-vs-per-call]]: stable dependencies can live in the runtime, while request-specific choices stay per call.

## What happens when I run it?

`generate(...)` resolves provider config, built-ins, extra tools, MCP tools, and skills, injects managed prompt guidance when needed, and dispatches to the selected provider adapter. `complete(...)`, `runCompletionLoop(...)`, `runtime.complete(...)`, and `runtime.streamComplete(...)` add a bounded model/tool loop with retry, stop, trace, and action-evidence handling. See [[src-runtime]] and [[src-completion-loop]].

If the model calls `ask_user_input`, package-managed completion advertises the contract by default, but default runtime handling surfaces a normal `tool_calls` result for the host. The host owns whether to pause, render a prompt, wait, time out, cancel, or resume. See [[host-owned-ask-user-input]] and [[src-runtime-complete-contract]].

## Where is data saved?

The package itself does not own durable storage. It may cache provider stores, MCP registries, and skill registries for convenience-path calls, and explicit runtimes own cleanup for runtime-created MCP registries. The host owns transcripts, workspaces, human answers, temp files, product records, and caller-injected registries.

## What are the important moving parts?

- [[src-runtime]] is the main API facade.
- [[src-completion-loop]] is the bounded iterative loop.
- [[src-builtins]] and [[src-builtin-executors]] define and execute reserved package tools.
- [[src-tool-validation]] turns malformed tool arguments into structured artifacts.
- [[src-mcp]], [[src-skills]], and [[provider-adapters]] wire external capability surfaces.
- [[system-prompt-schema]] and [[src-prompt-contracts]] explain managed system-message injection.

## What should I avoid breaking?

- Do not blur package-owned orchestration with host-owned UI, persistence, or policy.
- Do not make `ask_user_input` a runtime wait state again; keep it model-visible and host-handled by default.
- Do not weaken the trusted working-directory boundary for structured file tools.
- Do not treat human-input artifacts as action evidence for task completion.
- Do not make provider-specific tool names leak into the public tool-call surface.

Risk pages: [[shell-command-safeguards]], [[turn-loop-safety-and-lifecycle]], [[approval-and-synthetic-tool-call-messages]], [[host-owned-ask-user-input]], [[file-tool-contract-hardening]], and [[timeout-after-tool-result]].

## Where do I look first?

For a public API question, start at [[public-types]] and [[src-runtime]]. For loop behavior, start at [[src-completion-loop]]. For tool behavior, start at [[src-builtins]], [[src-builtin-executors]], and [[src-tool-validation]]. For recent contract changes, read [[host-owned-ask-user-input]], [[file-tool-contract-hardening]], and [[timeout-after-tool-result]].

Coverage note: this wiki reflects the current May 2026 package shape at commit `340f35e37d5263e09be8f7f9414e5995c9029374`, including host-owned `ask_user_input`, file-tool contract hardening, timeout-after-tool-result diagnostics, safer read-only defaults, runtime-facade completion helpers, shared prompt/provider-name helpers, provider stop metadata, and the legacy compatibility path in `src/turn-loop.ts`.
