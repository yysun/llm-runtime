## Summary

- Hardened `complete(...)` so default evidence is run-scoped and stale tool history no longer satisfies a new loop run.
- Rejected malformed `final_answer`, `need_user_input`, and `blocked` payloads as protocol violations and retried with the package recovery instruction.
- Changed default built-in exposure to a read-only set and hid deprecated HITL aliases unless `includeDeprecatedBuiltInAliases: true` is requested.
- Added top-level and runtime-facade `executeToolCall(...)` and `executeToolCalls(...)` helpers and updated the README examples to use them.
- Normalized provider-facing OpenAI-compatible tool names while mapping tool-call responses back to original runtime names.
- Replaced shallow tool validation with recursive schema validation for nested objects, arrays, enums, `minItems`, and nested required fields.
- Propagated abort signals into package-owned shell, web-fetch, and directory-walk executors.
- Added regression coverage for stale evidence, malformed control tools, loop-contract merging, safer built-in defaults, public execution helpers, recursive validation, and OpenAI tool-name normalization.

## Verification

- Ran `npm run check`
- Ran the full `tests/llm` suite
- Ran focused tests for `tests/llm/turn-loop.test.ts`
- Ran focused tests for `tests/llm/runtime.test.ts`
- Ran focused tests for `tests/llm/openai-direct.test.ts`
- Ran focused tests for `tests/llm/tool-validation.test.ts`

## Notes

- No E2E spec was added because this work hardens internal runtime behavior and public API defaults rather than introducing a new end-user workflow.
- No git commit was created in this run.
- Deprecated HITL aliases remain supported for compatibility during execution and can still be exposed explicitly when needed.