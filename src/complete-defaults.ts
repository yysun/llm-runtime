import { DEFAULT_READ_ONLY_BUILT_IN_TOOL_NAMES } from './builtins.js';
import type { BuiltInToolSelection } from './types.js';

export const DEFAULT_COMPLETE_BUILT_INS: BuiltInToolSelection = Object.freeze({
  ...Object.fromEntries(DEFAULT_READ_ONLY_BUILT_IN_TOOL_NAMES.map((toolName) => [toolName, true])),
  ask_user_input: true,
});
