/**
 * Completion-loop built-in defaults.
 *
 * Purpose:
 * - Define the package-managed fallback tool surface used by completion helpers.
 *
 * Key features:
 * - Defaults omitted `builtIns` to every package-owned built-in tool.
 *
 * Implementation notes:
 * - Completion still injects control tools separately; this constant only covers normal built-ins.
 *
 * Recent changes:
 * - 2026-05-28: Defaulted omitted `builtIns` to true so host integrations get the full package tool surface by default.
 * - 2026-05-27: Previously removed implicit read-only and ask_user_input built-ins.
 * - 2026-05-26: Previously kept ask_user_input model-visible by default while moving runtime handling to the host-owned tool-call path.
 */

import type { BuiltInToolSelection } from './types.js';

export const DEFAULT_COMPLETE_BUILT_INS: BuiltInToolSelection = true;
