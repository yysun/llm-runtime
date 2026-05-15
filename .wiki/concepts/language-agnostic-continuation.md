---
title: "Language-Agnostic Continuation"
type: "concept"
status: "active"
language: "default"
source_paths:
  - ".docs/reqs/2026/05/14/req-natural-language-continuation.md"
  - ".docs/plans/2026/05/14/plan-natural-language-continuation.md"
  - "README.md"
  - "src/index.ts"
  - "src/turn-loop.ts"
  - "tests/llm/turn-loop.test.ts"
updated_at: "2026-05-15"
---

In plain terms, language-agnostic continuation means the runtime does not trust a message just because it sounds confident or because it is written in English.

Instead, it asks a simpler question: did the assistant actually do the work yet?

That matters because weak model replies often sound like progress without being real progress:

- "I will check the file now."
- "Proceeding to search the record."
- "我现在去检查文件。"
- "好的，我先 search 一下。"

All of those can mean the same thing: the assistant is talking about the next step, not showing that the step already happened.

## The everyday version

Think of it like asking someone to look up a fact for you.

- If they say, "I will go check," the job is not done.
- If they come back with the result, the job is done.

`llm-runtime` now follows that same rule for tool-capable turns. It treats tool results as proof. It does not depend on the wording, the grammar, or the language of the assistant reply.

## How the runtime decides

For `respondWithTools(...)`, the package now uses a built-in default:

- if there is no tool-result evidence yet, plain text is treated as unresolved
- unresolved text gets an internal retry path instead of being accepted as the final answer
- once there is actual evidence in the transcript, a later plain-text answer can complete normally

This is why the feature is language-agnostic. The main rule is based on evidence, not phrases.

## What still uses English patterns

The runtime still keeps a few English patterns such as "I will..." or "Proceeding...", but only as a secondary hint.

Their job is to label the problem more specifically as `intent_only_narration` when possible. If the text is in another language or mixed language, the runtime can still reject it as unresolved using the broader `non_progressing` label.

So the English patterns help describe the issue, but they are no longer the thing that makes the loop safe.

## Why this feels more natural

Without this behavior, a client can get stuck after the model says something like "I will check" because the runtime might treat that narration as the end of the turn.

With the newer behavior:

- the runtime keeps going internally for bounded recovery
- the client does not need to send an extra follow-up user message just to make the assistant continue
- the loop still has explicit stop reasons if the model keeps failing to make progress

That is closer to how users expect agent-style tools to behave: keep working until there is a real result or a clear bounded stop.

## What this does not mean

It does not mean every text reply must contain a new tool call.

If the assistant already has enough evidence from earlier tool results, a normal text answer can still be accepted as final. The key point is that final text must be grounded in available evidence, not just in a promise to act later.

## Where to look next

- [[src-turn-loop]] for the loop structure and callback ownership
- [[action-execution-hardening]] for the earlier false-success fix
- [[turn-loop-safety-and-lifecycle]] for loop bounds, stop reasons, and lifecycle tracing