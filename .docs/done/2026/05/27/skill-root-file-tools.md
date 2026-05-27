# Done: Skill Root File Tools

**Date**: 2026-05-27
**Requirement**: Thread request: support `load_skill` file references while preserving workspace-root compatibility
**Plan**: Thread-local implementation
**Status**: Completed

## Summary

- Added loaded-skill provenance for read-only file tools so skill-referenced paths resolve from the loaded skill root.
- Kept normal workspace-relative paths rooted at `context.workingDirectory`.
- Kept `write_file` and `create_directory` workspace-root-only so skill context cannot redirect write targets.
- Updated built-in tool descriptions to state the skill-reference vs workspace-root behavior.
- Added regression coverage for `read_file`, `list_files`, and `search_files` under loaded skill context, plus workspace fallback and create-directory safety.

## Verification

- `npx vitest run tests/llm/runtime.test.ts -t "resolves read_file, list_files, and search_files|creates directories"` passed.
- `npm run check` passed.
- `npm test` passed with 164 tests.

## Notes

- No E2E spec was added because this is internal runtime path-resolution behavior.
- Skill-root read behavior is tied to actual loaded skill context, not merely configured `skillRoots`.
