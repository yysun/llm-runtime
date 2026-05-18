# Done: File Tool Contract Hardening

**Date**: 2026-05-18
**Requirement**: `.docs/reqs/2026/05/18/req-file-tool-contract-hardening.md`
**Plan**: `.docs/plans/2026/05/18/plan-file-tool-contract-hardening.md`
**Status**: Completed

## Summary

- Removed the `read_file` skill-root fallback so the built-in stays scoped to the trusted working directory.
- Removed the fixed hard `read_file` line cap while keeping paginated reads through `offset` and `limit`.
- Aligned `read_file` and `write_file` validation with their required path arguments and preserved alias normalization.
- Made hidden-path discovery opt-in for `list_files` and `search_files`, and removed unconditional exclusion of `.git`, `node_modules`, and `dist` paths.
- Made `path_exists` symlink-aware so existing symlinks are distinguished from missing paths.

## Verification

- `tests/llm/runtime.test.ts` passed with 52 tests after adding focused coverage for uncapped reads, scope enforcement, hidden entry discovery, write validation, and symlink semantics.
- `npm run check` passed.
- `npm test` passed with 157 tests.

## Notes

- No E2E spec was added because this story changes internal built-in contract behavior rather than a user-facing flow.
- The current `list_files` recursive depth cap remains in place; this story narrowed the contract gap around hidden and excluded paths without changing that separate limit.