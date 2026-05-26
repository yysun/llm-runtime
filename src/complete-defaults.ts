/**
 * Completion-loop built-in defaults.
 *
 * Purpose:
 * - Define the package-managed tool surface used by completion helpers when callers do not provide one.
 *
 * Key features:
 * - Includes read-only workspace tools for safe discovery.
 * - Includes the standard human-input contract so models know how to ask for required user decisions.
 *
 * Implementation notes:
 * - Default exposure is model-facing. Runtime-owned helpers still decide separately whether a tool call is executable or host-handled.
 *
 * Recent changes:
 * - 2026-05-26: Kept ask_user_input model-visible by default while moving runtime handling to the host-owned tool-call path.
 */

import { DEFAULT_READ_ONLY_BUILT_IN_TOOL_NAMES } from './builtins.js';
import type { BuiltInToolSelection } from './types.js';

export const DEFAULT_COMPLETE_BUILT_INS: BuiltInToolSelection = Object.freeze({
  ...Object.fromEntries(DEFAULT_READ_ONLY_BUILT_IN_TOOL_NAMES.map((toolName) => [toolName, true])),
  ask_user_input: true,
});
