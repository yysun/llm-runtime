/**
 * LLM Package Public Entrypoint
 *
 * Purpose:
 * - Export the public API for the publishable `@agent-world/llm` workspace.
 *
 * Key features:
 * - Per-call `generate(...)`, `stream(...)`, and explicit environment export.
 * - Package-owned provider configuration helpers.
 * - Package-owned built-in tool catalog and runtime helpers.
 * - MCP, skill, and tool registry helpers and types.
 *
 * Implementation notes:
 * - Keeps the package surface explicit and typed.
 * - Avoids package-to-core imports so the workspace stays publishable.
 * - Serves as the primary import target for `core` and external consumers.
 *
 * Recent changes:
 * - 2026-03-27: Initial public API for `packages/llm`.
 */

export * from './types.js';
export * from './builtins.js';
export * from './llm-config.js';
export * from './mcp.js';
export * from './skills.js';
export * from './tools.js';
export * from './tool-validation.js';
export {
  createLLMEnvironment,
  generate,
  resolveTools,
  resolveToolsAsync,
  stream,
} from './runtime.js';
export * from './openai-direct.js';
export * from './anthropic-direct.js';
export * from './google-direct.js';
