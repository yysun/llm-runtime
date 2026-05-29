# Plan: Copilot Pattern Runtime

## Scope

Move `llm-runtime` to a hybrid completion model: reliable mechanical loop state plus best-effort semantic `final_answer`.

## Tasks

- [x] Inspect relevant files
- [x] Make focused changes
- [x] Run validation
- [x] Update docs/status

## Design

```mermaid
flowchart TD
  A["Model response"] --> B{"Tool calls?"}
  B -->|"yes"| C["Return or execute tool calls"]
  C --> D["Resume loop with tool results"]
  B -->|"no"| E{"Text only"}
  E --> F{"Generic evidence sufficient?"}
  F -->|"yes"| G["Accept text as final"]
  F -->|"no"| H["Reject and continue"]
  B -->|"final_answer"| I{"Evidence sufficient?"}
  I -->|"yes"| J["Accept semantic final"]
  I -->|"no"| H
```

## Implementation Notes

- Keep `final_answer` as a runtime control tool, but phrase it as preferred protocol.
- Use evidence kinds rather than product-specific checks.
- Keep `ask_user_input` host-owned and resumable.
- Treat successful write, external action, or artifact evidence as enough to accept a no-tool text response after interaction.

## E2E Coverage

No separate E2E spec is needed. This is an internal runtime contract with deterministic unit coverage across `complete()` and `streamComplete()`.
