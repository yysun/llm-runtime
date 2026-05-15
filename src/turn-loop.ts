/**
 * LLM Package Turn Loop Compatibility Entrypoint
 *
 * Purpose:
 * - Preserve the legacy `src/turn-loop.ts` import path while the preferred implementation lives in `src/completion-loop.ts`.
 *
 * Key features:
 * - Re-exports the full completion-loop surface.
 * - Keeps backward-compatible file-path imports working.
 *
 * Implementation notes:
 * - The canonical implementation lives in `src/completion-loop.ts`.
 * - This file stays as a thin compatibility layer only.
 *
 * Recent changes:
 * - 2026-05-15: Removed the stale duplicate implementation so legacy imports use the canonical hardened completion-loop surface.
 * - 2026-05-15: Converted the legacy turn-loop file into a compatibility re-export for the renamed completion-loop API.
 */

export * from './completion-loop.js';
