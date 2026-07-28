# Plan: Fail-Closed Tool Approval

## Goal

Make human-input normalization and executable tool authorization fail closed
while preserving the existing host-owned UI boundary. A cancelled approval
must become a terminal runtime result before any tool in its batch executes.

## Current Context

- `src/human-input-contract.ts` owns the canonical model-facing
  `ask_user_input` schema and currently conflates `allowSkip` with
  non-blocking decisions while mentioning approval as a supported use.
- `src/runtime-complete-contract.ts` defines completion results and currently
  serializes arbitrary human answers without validation.
- `src/runtime.ts` returns non-executable tools, including default
  `ask_user_input`, to the host before execution. For executable-only batches,
  it invokes `onToolApproval` immediately before each corresponding execution
  and turns rejection into a recoverable failure artifact.
- `src/types.ts` exposes the boolean approval response and runtime option.
- `src/prompt-contracts.ts` directs approval requests toward
  `ask_user_input`.
- `README.md` documents host resume but does not define validated human-input
  outcomes or terminal approval cancellation.
- `tests/llm/runtime.test.ts` covers host-owned batching and valid resume but
  not malformed human answers, strict approval decisions, terminal
  cancellation, or approval batch atomicity.
- `tests/e2e/llm-host-owned-tool-calls.ts` provides a local provider-backed E2E
  harness suitable for the new cancellation path without external services.

## Decisions

- Preserve the current ownership boundary: the host owns presentation and
  clocks; the package owns request/result schemas, validation, orchestration,
  and execution safety.
- Reserve `ask_user_input` for clarification and preference collection. It may
  gather a workflow choice, but it does not authorize a later tool call.
- Add `allowOther` per question. A non-option string is accepted only for a
  single-select question that explicitly enables it; multiple-select values
  remain option IDs so cardinality and intent stay unambiguous.
- Introduce a public normalized outcome union and helper. The helper consumes
  the pending request plus a raw host response and returns `answered` or
  `cancelled`; it does not render, wait, or resume.
- Define the human-input protocol as:
  - `AskUserInputRawResponse` is either
    `{ status: "answered"; answers: Record<string, string | string[]> }` or
    `{ status: "cancelled"; reason: "rejected" | "skipped" | "dismissed" |
    "timeout"; message?: string }`.
  - `AskUserInputOutcome` preserves valid answered responses and adds
    `{ status: "cancelled"; reason: ... | "invalid"; message?: string }` for
    validation failures.
  - Request question IDs and option IDs must be non-empty and unique. Answered
    responses must contain every question exactly once and no unknown question.
    Single-select answers are one non-empty string; a non-option string is
    accepted only with `allowOther: true`. Multiple-select answers are a
    non-empty array of unique declared option IDs; `allowOther` is invalid for
    multiple-select requests.
  - `normalizeAskUserInputOutcome(pending, raw)` returns the union.
    `createAskUserInputResult(pending, answeredOutcome)` accepts only an
    answered outcome and creates the normal tool-result message. Cancelled
    outcomes are terminal host decisions and are not resumed.
- Replace the boolean approval response with a discriminated
  `decision: "approve" | "cancel"` union. Do not add a compatibility flag or
  truthy fallback because this is a security boundary.
- Define approval responses as `{ decision: "approve" }` or
  `{ decision: "cancel"; reason: "rejected" | "dismissed" | "timeout";
  message?: string }`. The runtime maps malformed callback values to
  `approval_invalid` and thrown/rejected callbacks to
  `approval_callback_error`; neither may execute a tool. A host-owned timer
  reports its expiry as `decision: "cancel", reason: "timeout"`; the runtime
  does not create a timer and cannot resolve a callback that never settles.
- Keep approval opt-in. When `onToolApproval` is absent, executable tools retain
  existing automatic execution.
- Add terminal `cancelled` completion status, cancellation metadata, and a
  streaming cancellation event. Cancellation metadata is
  `{ kind: "tool_approval"; reason: "approval_rejected" |
  "approval_dismissed" | "approval_timeout" | "approval_invalid" |
  "approval_callback_error"; toolCall: LLMToolCall; message?: string }`.
- Preflight approval callbacks sequentially for the whole executable batch
  before emitting tool-start events or executing any tool. Sequential
  collection avoids overlapping host prompts while still preventing partial
  execution.
- Parse every executable tool call before requesting approval. If any argument
  payload is invalid JSON or not an object, append failure tool results for the
  batch and continue to the model without calling approval callbacks or
  executors. The malformed calls retain their existing parse failure codes;
  otherwise-valid peers receive a `batch_preflight_failed` execution code.
- Leave host-owned batches unchanged: the runtime returns the entire batch to
  the host and does not call `onToolApproval` for tools it cannot execute.
- Increment the pre-1.0 minor package version because approval callback and
  result unions are public contract changes.
- Add local E2E coverage because approval is a regression-prone execution
  safety boundary.

## Phased Tasks

### Phase 1 - Discovery and scope lock

- [x] Inspect `src/human-input-contract.ts`,
  `src/runtime-complete-contract.ts`, `src/runtime.ts`, `src/types.ts`,
  `src/prompt-contracts.ts`, and public exports to confirm the current
  ownership and execution paths.
- [x] Inspect `tests/llm/runtime.test.ts`,
  `tests/llm/runtime-provider.test.ts`, and
  `tests/e2e/llm-host-owned-tool-calls.ts` to identify stable test seams for
  result validation and approval batch execution.
- [x] Confirm that runtime-owned UI, timers, persistence, approval inference,
  compatibility flags, and unrelated loop refactors remain out of scope.

### Phase 2 - Human-input protocol

- [x] Update `src/human-input-contract.ts` so each question may opt into
  free-form input and dismissal is documented as cancellation, never consent.
- [x] Add typed human-input raw response, answer, cancellation, and outcome
  contracts to `src/runtime-complete-contract.ts`.
- [x] Implement and export a human-input normalization helper that validates
  request shape, unique IDs, exact question coverage, selection cardinality,
  option membership, and free-form permission according to the public unions
  fixed in `## Decisions`, without owning host UI behavior.
- [x] Update `src/prompt-contracts.ts` so `ask_user_input` is not presented as
  executable tool authorization.

### Phase 3 - Fail-closed executable approval

- [x] Replace the boolean approval response in `src/types.ts` with an explicit
  approve-or-cancel union and typed cancellation reasons.
- [x] Extend `src/runtime-complete-contract.ts` and public exports with
  cancelled buffered and streaming result contracts.
- [x] Refactor the executable batch path in `src/runtime.ts` to collect and
  validate every approval decision before any execution begins, while
  preserving automatic execution when no callback is configured.
- [x] Preflight argument JSON/shape for every executable call before approval;
  on failure, return failure tool results for the whole batch with no approval
  or execution.
- [x] Make the first cancelled or malformed approval decision terminate the
  run with cancellation metadata, no tool execution, and no additional model
  call.
- [x] Normalize thrown or rejected approval callbacks to
  `approval_callback_error`; document that host timeouts must return the
  explicit timeout cancellation decision.
- [x] Preserve the existing atomic stop for batches containing a host-owned
  tool and confirm that package-owned executors and approval callbacks remain
  untouched in that branch.

### Phase 4 - Tests and E2E verification wiring

- [x] Add unit tests in `tests/llm/runtime.test.ts` for valid option answers,
  explicit free-form answers, malformed answers, skipped/dismissed/timed-out
  outcomes, strict approval decisions, terminal cancellation, and batch
  atomicity.
- [x] Add unit tests proving duplicate request IDs, duplicate option IDs,
  partial/extra answers, empty selections, multiple-select free-form values,
  malformed tool arguments, legacy `{ approved: true }`, legacy boolean
  `true`, callback errors, and omitted approval callbacks follow the fixed
  contracts in `## Decisions`.
- [x] Update prompt and schema assertions in
  `tests/llm/runtime-provider.test.ts` and `tests/llm/runtime.test.ts` for the
  clarified ownership contract.
- [x] Add a local provider-backed scenario to
  `tests/e2e/llm-host-owned-tool-calls.ts` proving explicit approval reaches a
  second provider completion, explicit cancellation and malformed legacy
  responses stop before execution or a second request, and second-call batch
  denial executes neither tool.
- [x] Add streaming unit coverage proving cancellation emits exactly one
  `cancelled` terminal event, no `failed`, `tool_start`, `tool_result`, or
  `tool_error` event, no executor call, and no second provider request.
- [x] Run `npm run check`, `npm run build`, `npm test`,
  `npm run test:e2e:host-owned`, and `npm pack --dry-run`; record passing
  command evidence.

### Phase 5 - Documentation, versioning, and status

- [x] Update `README.md` with the host/runtime division, normalized
  human-input outcomes, `allowOther`, approval callback migration, terminal
  cancellation, and batch preflight behavior.
- [x] Update `package.json` and `package-lock.json` with the appropriate
  pre-1.0 minor version increment.
- [x] Confirm no compatibility flag, fallback approval parser, runtime-owned
  timer, or UI behavior was introduced.
- [x] Record final verification and review evidence, then mark plan tasks
  complete only where matching evidence exists.

## Validation

- `npm run check`
  - Expected: TypeScript completes with no errors after all public union and
    callback migrations.
- `npm run build`
  - Expected: declaration and JavaScript output compile with the new helper,
    result status, cancellation metadata, callback union, and stream event
    available from the package root.
- `npm test`
  - Expected: all `tests/llm` suites pass, including strict approval and
    human-input outcome cases; streaming cancellation emits only the cancelled
    terminal path.
- `npm run test:e2e:host-owned`
  - Expected: the local host-owned E2E suite proves unchanged host resume,
    explicit approval completion, explicit and malformed cancellation without
    a second provider request, and zero partial batch execution.
- `npm pack --dry-run`
  - Expected: the versioned package contains compiled declarations and
    JavaScript exposing the new public contracts without creating a tarball.
- Code review
  - Expected: no major correctness, security, compatibility-documentation, or
    batch-atomicity flaws.
- Verification review
  - Expected: every acceptance criterion has direct code, test, documentation,
    or package metadata evidence.

## Rollback / Risk

- The approval callback response and completion status unions are public and
  intentionally breaking. The version increment and README migration example
  must make the change explicit.
- Exhaustive consumers of runtime status and streaming event unions must add a
  cancelled branch.
- Returning cancellation before appending tool results leaves the model-issued
  assistant tool call as the terminal transcript boundary. This is deliberate:
  the run is not resumed after denial.
- Approval callbacks can have host-visible effects such as showing prompts.
  They are collected sequentially; if a later prompt cancels, earlier prompts
  remain historical decisions but no tool executes.
- A callback that never settles remains a host integration bug because timeout
  clocks are host-owned. Hosts that enforce timeouts must settle the callback
  with the explicit timeout cancellation decision.
- Rollback consists of reverting this story as one commit; there is no data
  migration or persistent state cleanup.

## Implementation Evidence

- Architecture review: passed after resolving approval defaults, callback
  failure handling, public union shapes, exact argument preflight, streaming
  coverage, and package validation.
- Code review: passed after hardening exact plain approval objects, freezing
  configured approval snapshots through execution, preserving no-approval
  `onToolCall` mutability, and protecting special human-input IDs.
- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: 11 test files and 198 tests passed.
- `npm run test:e2e:host-owned`: passed all host-owned input, explicit
  approval, cancellation, batch atomicity, and streaming cancellation
  scenarios.
- `npm_config_cache=/private/tmp/llm-runtime-npm-cache npm pack --dry-run`:
  passed and listed the `llm-runtime@0.7.0` compiled package contents.
