# Done: Built-In Filesystem Tools

**Date**: 2026-05-14
**Requirement**: `.docs/reqs/2026/05/14/req-builtin-filesystem-tools.md`
**Plan**: `.docs/plans/2026/05/14/plan-builtin-filesystem-tools.md`
**Status**: Completed

## Summary

Removed the built-in `grep` tool and replaced it with `search_files`, `create_directory`, and `path_exists` across the runtime type surface, built-in catalog, executor registry, validation path, tests, README, and repo wiki.

As part of the implementation, built-in filesystem traversal no longer depends on `fast-glob`; the runtime now uses package-owned directory walking and glob matching helpers, and the unused dependency was removed from the package manifest and lockfile.

## Verification

- `vitest` unit suite passed: 85 tests.
- `npm run check` passed.
- `npm run test:e2e:dry-run` passed.
- `git diff --check` passed.

## Notes

- `grep` is now rejected as an unknown built-in selection key instead of being silently ignored when callers bypass types.
- `search_files` is intentionally file-discovery oriented and does not provide content-search behavior.