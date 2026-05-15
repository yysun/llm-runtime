/**
 * LLM Package Built-In Executors
 *
 * Purpose:
 * - Provide package-owned implementations for reusable built-in tools.
 *
 * Key features:
 * - Internal executors for shell, file, web-fetch, and load-skill tools.
 * - Package-owned HITL pending request artifacts with no host adapter dependency.
 * - Trusted working-directory enforcement for file and shell operations.
 *
 * Implementation notes:
 * - The package owns tool behavior; callers only configure enablement and optional extra tools.
 * - Working directory defaults to the explicit execution context and falls back to `process.cwd()`.
 * - Output contracts stay deterministic and string-based for compatibility with current callers.
 *
 * Recent changes:
 * - 2026-05-15: Propagated abort signals into package-owned shell, web-fetch, and directory-walk executors.
 * - 2026-05-15: Added the deprecated `ask_user_question` HITL executor alias alongside `ask_user_input`.
 * - 2026-03-27: Added package-owned executors for built-in tools.
 * - 2026-05-14: Replaced `grep` with `search_files`, `create_directory`, and `path_exists`.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { formatToolValidationFailureArtifact } from './tool-validation.js';
import type {
  BuiltInToolName,
  HitlInputOption,
  HitlInputQuestion,
  HitlSelectionType,
  LLMToolExecutionContext,
  PendingHitlToolResult,
  SkillRegistry,
  ToolValidationIssue,
} from './types.js';

type BuiltInExecutor = (
  args: Record<string, unknown>,
  context?: LLMToolExecutionContext,
) => Promise<unknown> | unknown;

type BuiltInExecutorOptions = {
  skillRegistry: SkillRegistry;
};

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_LIST_MAX_ENTRIES = 200;
const DEFAULT_LIST_MAX_DEPTH = 2;
const DEFAULT_SEARCH_MAX_RESULTS = 200;
const DEFAULT_SHELL_TIMEOUT_MS = 600_000;
const DEFAULT_WEB_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_WEB_FETCH_MAX_CHARS = 16_000;

function createAbortError(reason?: unknown): Error {
  const reasonMessage = reason instanceof Error
    ? reason.message
    : typeof reason === 'string' && reason.trim()
      ? reason
      : 'The operation was aborted.';
  const message = /abort/i.test(reasonMessage)
    ? reasonMessage
    : `The operation was aborted: ${reasonMessage}`;
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw createAbortError(signal.reason);
}

function relayAbortSignal(source: AbortSignal | undefined, onAbort: (reason?: unknown) => void): () => void {
  if (!source) {
    return () => undefined;
  }

  if (source.aborted) {
    onAbort(source.reason);
    return () => undefined;
  }

  const handler = () => onAbort(source.reason);
  source.addEventListener('abort', handler, { once: true });
  return () => source.removeEventListener('abort', handler);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getEnvValueFromText(text: unknown, key: string): string | undefined {
  if (typeof text !== 'string' || !text.trim()) {
    return undefined;
  }

  const prefix = `${key}=`;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }

  return undefined;
}

function getTrustedWorkingDirectory(context?: LLMToolExecutionContext): string {
  const explicit = typeof context?.workingDirectory === 'string' ? context.workingDirectory.trim() : '';
  if (explicit) {
    return path.resolve(explicit);
  }

  const worldVariables = typeof (context?.world as { variables?: unknown } | undefined)?.variables === 'string'
    ? (context?.world as { variables?: string }).variables
    : undefined;
  const worldDirectory = getEnvValueFromText(worldVariables, 'working_directory');
  if (worldDirectory) {
    return path.resolve(worldDirectory);
  }

  return process.cwd();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = normalizePath(path.resolve(candidatePath)).replace(/\/+$/, '');
  const normalizedRoot = normalizePath(path.resolve(rootPath)).replace(/\/+$/, '');
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function resolveScopedPath(inputPath: string, trustedWorkingDirectory: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Missing required path parameter');
  }

  const resolvedPath = path.resolve(trustedWorkingDirectory, inputPath);
  if (!isPathWithinRoot(resolvedPath, trustedWorkingDirectory)) {
    throw new Error('Working directory mismatch: requested path is outside trusted working directory');
  }

  return resolvedPath;
}

function escapeRegExp(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizePath(pattern);
  let expression = '^';

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];

    if (character === '*') {
      const nextCharacter = normalizedPattern[index + 1];
      const followingCharacter = normalizedPattern[index + 2];

      if (nextCharacter === '*') {
        if (followingCharacter === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
        continue;
      }

      expression += '[^/]*';
      continue;
    }

    if (character === '?') {
      expression += '[^/]';
      continue;
    }

    expression += escapeRegExp(character);
  }

  expression += '$';
  return new RegExp(expression);
}

function matchesGlobPattern(candidatePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizePath(candidatePath));
}

function matchesIncludePattern(candidatePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return true;
  }

  if (/[*?]/.test(normalizedPattern)) {
    return matchesGlobPattern(candidatePath, normalizedPattern);
  }

  return candidatePath.includes(normalizedPattern);
}

function shouldIgnoreRelativePath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath).replace(/\/$/, '');
  if (!normalized) {
    return false;
  }

  const segments = normalized.split('/');
  return segments.includes('node_modules') || segments.includes('.git') || segments.includes('dist');
}

async function collectDirectoryEntries(rootPath: string, options: {
  includeHidden: boolean;
  maxDepth: number;
  onlyFiles: boolean;
  abortSignal?: AbortSignal;
}): Promise<Array<{ path: string; isDirectory: boolean }>> {
  const entries: Array<{ path: string; isDirectory: boolean }> = [];

  async function walkDirectory(currentPath: string, depth: number): Promise<void> {
    throwIfAborted(options.abortSignal);
    const directoryEntries = await fs.readdir(currentPath, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const directoryEntry of directoryEntries) {
      throwIfAborted(options.abortSignal);
      if (!options.includeHidden && directoryEntry.name.startsWith('.')) {
        continue;
      }

      const absolutePath = path.join(currentPath, directoryEntry.name);
      const relativePath = normalizePath(path.relative(rootPath, absolutePath));
      if (!relativePath || shouldIgnoreRelativePath(relativePath)) {
        continue;
      }

      const isDirectory = directoryEntry.isDirectory();
      if (!options.onlyFiles || !isDirectory) {
        entries.push({
          path: isDirectory ? `${relativePath}/` : relativePath,
          isDirectory,
        });
      }

      if (isDirectory && depth + 1 < options.maxDepth) {
        await walkDirectory(absolutePath, depth + 1);
      }
    }
  }

  await walkDirectory(rootPath, 0);
  return entries;
}

function stripYamlFrontMatter(markdown: string): string {
  const frontMatterPattern = /^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
  return markdown.replace(frontMatterPattern, '');
}

function toUtf8String(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return value == null ? '' : String(value);
}

async function createReadFileExecutor(options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  try {
    const trustedWorkingDirectory = getTrustedWorkingDirectory(context);
    const requestedFilePath = String(args.filePath ?? args.path ?? '').trim();
    if (!requestedFilePath) {
      return 'Error: read_file failed - filePath is required';
    }

    let resolvedPath = resolveScopedPath(requestedFilePath, trustedWorkingDirectory);
    let rawContent = '';

    try {
      rawContent = await fs.readFile(resolvedPath, 'utf8');
    } catch (error) {
      const skills = await options.skillRegistry.listSkills();
      let fallbackLoaded = false;
      for (const skill of skills) {
        const skillRoot = path.dirname(skill.sourcePath);
        const candidatePath = path.resolve(skillRoot, requestedFilePath);
        if (!isPathWithinRoot(candidatePath, skillRoot)) {
          continue;
        }
        try {
          rawContent = await fs.readFile(candidatePath, 'utf8');
          resolvedPath = candidatePath;
          fallbackLoaded = true;
          break;
        } catch {
          // continue
        }
      }
      if (!fallbackLoaded) {
        throw error;
      }
    }

    const lines = toUtf8String(rawContent).split(/\r?\n/);
    const offset = clamp(Number(args.offset ?? 1), 1, Number.MAX_SAFE_INTEGER);
    const limit = clamp(Number(args.limit ?? DEFAULT_READ_LIMIT), 1, DEFAULT_READ_LIMIT);

    return JSON.stringify({
      filePath: resolvedPath,
      offset,
      limit,
      totalLines: lines.length,
      content: lines.slice(offset - 1, offset - 1 + limit).join('\n'),
    }, null, 2);
  } catch (error) {
    return `Error: read_file failed - ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function createWriteFileExecutor(_options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  try {
    if (context?.toolPermission === 'read') {
      return 'Error: write_file is blocked by the current permission level (read).';
    }

    const trustedWorkingDirectory = getTrustedWorkingDirectory(context);
    const requestedFilePath = String(args.filePath ?? args.path ?? '').trim();
    if (!requestedFilePath) {
      return 'Error: write_file failed - filePath is required';
    }
    if (typeof args.content !== 'string') {
      return 'Error: write_file failed - content must be a string';
    }

    const mode = String(args.mode ?? 'overwrite').trim().toLowerCase();
    const resolvedPath = resolveScopedPath(requestedFilePath, trustedWorkingDirectory);
    const parentDirectory = path.dirname(resolvedPath);
    if (!isPathWithinRoot(parentDirectory, trustedWorkingDirectory)) {
      return 'Error: write_file failed - Working directory mismatch';
    }

    await fs.mkdir(parentDirectory, { recursive: true });
    await fs.writeFile(
      resolvedPath,
      args.content,
      mode === 'create'
        ? { encoding: 'utf8', flag: 'wx' }
        : { encoding: 'utf8', flag: 'w' },
    );

    return JSON.stringify({
      ok: true,
      status: 'success',
      filePath: resolvedPath,
      mode: mode === 'create' ? 'create' : 'overwrite',
      bytesWritten: Buffer.byteLength(args.content, 'utf8'),
    }, null, 2);
  } catch (error) {
    return `Error: write_file failed - ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function createListFilesExecutor(_options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  try {
    const trustedWorkingDirectory = getTrustedWorkingDirectory(context);
    const requestedPath = String(args.path ?? '.');
    const resolvedPath = resolveScopedPath(requestedPath, trustedWorkingDirectory);
    const recursive = Boolean(args.recursive ?? false);
    const includeHidden = Boolean(args.includeHidden ?? true);
    const maxDepth = clamp(Number(args.maxDepth ?? (recursive ? DEFAULT_LIST_MAX_DEPTH : 1)), 1, DEFAULT_LIST_MAX_DEPTH);
    const maxEntries = clamp(Number(args.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES), 1, DEFAULT_LIST_MAX_ENTRIES);
    const includePattern = String(args.includePattern ?? '').trim();

    const entries = await collectDirectoryEntries(resolvedPath, {
      includeHidden,
      maxDepth: recursive ? maxDepth : 0,
      onlyFiles: false,
      abortSignal: context?.abortSignal,
    });

    const filteredEntries = entries
      .map((entry) => entry.path)
      .filter((entry: string) => !includePattern || matchesIncludePattern(entry, includePattern))
      .sort((left: string, right: string) => left.localeCompare(right));

    const truncated = filteredEntries.length > maxEntries;
    const returnedEntries = truncated ? filteredEntries.slice(0, maxEntries) : filteredEntries;

    return JSON.stringify({
      requestedPath,
      path: resolvedPath,
      recursive,
      includePattern: includePattern || undefined,
      maxEntries,
      total: filteredEntries.length,
      returned: returnedEntries.length,
      truncated,
      entries: returnedEntries,
      found: filteredEntries.length > 0,
      message: filteredEntries.length === 0
        ? 'No files or directories found in the requested path.'
        : truncated
          ? `Result truncated to ${maxEntries} entries out of ${filteredEntries.length}.`
          : undefined,
    }, null, 2);
  } catch (error) {
    return `Error: list_files failed - ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function createSearchFilesExecutor(_options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  try {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) {
      return 'Error: search_files failed - pattern must be a non-empty string';
    }

    const trustedWorkingDirectory = getTrustedWorkingDirectory(context);
    const searchRoot = args.path
      ? resolveScopedPath(String(args.path), trustedWorkingDirectory)
      : trustedWorkingDirectory;
    const includeHidden = Boolean(args.includeHidden ?? true);
    const maxResults = clamp(Number(args.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS), 1, DEFAULT_SEARCH_MAX_RESULTS);

    const entries = await collectDirectoryEntries(searchRoot, {
      includeHidden,
      maxDepth: Number.MAX_SAFE_INTEGER,
      onlyFiles: true,
      abortSignal: context?.abortSignal,
    });

    const normalizedEntries = entries
      .map((entry) => entry.path)
      .filter((entry: string) => matchesGlobPattern(entry, pattern))
      .sort((left: string, right: string) => left.localeCompare(right));
    const truncated = normalizedEntries.length > maxResults;
    const returnedEntries = truncated ? normalizedEntries.slice(0, maxResults) : normalizedEntries;

    return JSON.stringify({
      requestedPath: String(args.path ?? '.'),
      path: searchRoot,
      pattern,
      maxResults,
      total: normalizedEntries.length,
      returned: returnedEntries.length,
      truncated,
      entries: returnedEntries,
      found: normalizedEntries.length > 0,
      message: normalizedEntries.length === 0
        ? 'No files matched the requested pattern.'
        : truncated
          ? `Result truncated to ${maxResults} entries out of ${normalizedEntries.length}.`
          : undefined,
    }, null, 2);
  } catch (error) {
    return `Error: search_files failed - ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function createDirectoryExecutor(_options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  try {
    if (context?.toolPermission === 'read') {
      return 'Error: create_directory is blocked by the current permission level (read).';
    }

    const trustedWorkingDirectory = getTrustedWorkingDirectory(context);
    const requestedPath = String(args.path ?? '').trim();
    if (!requestedPath) {
      return 'Error: create_directory failed - path is required';
    }

    const resolvedPath = resolveScopedPath(requestedPath, trustedWorkingDirectory);
    const existingStats = await fs.stat(resolvedPath).catch(() => null);
    if (existingStats && !existingStats.isDirectory()) {
      return 'Error: create_directory failed - target path already exists and is not a directory';
    }

    await fs.mkdir(resolvedPath, { recursive: true });

    return JSON.stringify({
      ok: true,
      status: 'success',
      path: resolvedPath,
      created: existingStats == null,
      existed: existingStats != null,
    }, null, 2);
  } catch (error) {
    return `Error: create_directory failed - ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function createPathExistsExecutor(_options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  try {
    const trustedWorkingDirectory = getTrustedWorkingDirectory(context);
    const requestedPath = String(args.path ?? '').trim();
    if (!requestedPath) {
      return 'Error: path_exists failed - path is required';
    }

    const resolvedPath = resolveScopedPath(requestedPath, trustedWorkingDirectory);
    const stats = await fs.stat(resolvedPath).catch(() => null);

    return JSON.stringify({
      path: resolvedPath,
      exists: stats != null,
      type: stats == null
        ? null
        : stats.isDirectory()
          ? 'directory'
          : stats.isFile()
            ? 'file'
            : 'other',
      isDirectory: stats?.isDirectory() ?? false,
      isFile: stats?.isFile() ?? false,
    }, null, 2);
  } catch (error) {
    return `Error: path_exists failed - ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function createWebFetchExecutor(_options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  try {
    throwIfAborted(context?.abortSignal);
    const rawUrl = String(args.url ?? '').trim();
    if (!rawUrl) {
      return 'Error: web_fetch failed - invalid_url: url is required';
    }

    const timeoutMs = clamp(Number(args.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS), 1000, 120_000);
    const maxChars = clamp(Number(args.maxChars ?? DEFAULT_WEB_FETCH_MAX_CHARS), 100, 200_000);
    const controller = new AbortController();
    const cleanupAbortRelay = relayAbortSignal(context?.abortSignal, (reason) => controller.abort(createAbortError(reason)));
    const timeoutId = setTimeout(() => controller.abort(createAbortError(`web_fetch timed out after ${timeoutMs}ms`)), timeoutMs);

    try {
      const response = await fetch(rawUrl, { signal: controller.signal });
      const contentType = response.headers.get('content-type') || '';
      const bodyText = await response.text();
      const normalizedBody = contentType.includes('application/json')
        ? JSON.stringify(JSON.parse(bodyText), null, 2)
        : bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const markdown = normalizedBody.slice(0, maxChars);

      return JSON.stringify({
        url: rawUrl,
        resolvedUrl: response.url || rawUrl,
        status: response.status,
        ok: response.ok,
        contentType: contentType || null,
        mode: contentType.includes('json') ? 'json' : contentType.includes('html') ? 'html' : 'text',
        markdown,
        truncated: normalizedBody.length > markdown.length,
      }, null, 2);
    } finally {
      cleanupAbortRelay();
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: web_fetch failed - ${message}`;
  }
}

async function createLoadSkillExecutor(options: BuiltInExecutorOptions, args: Record<string, unknown>): Promise<string> {
  const skillId = String(args.skill_id ?? '').trim();
  if (!skillId) {
    return [
      '<skill_context id="">',
      '  <error>',
      '    Missing required parameter: skill_id',
      '  </error>',
      '</skill_context>',
    ].join('\n');
  }

  const skill = await options.skillRegistry.loadSkill(skillId);
  if (!skill) {
    return [
      `<skill_context id="${skillId}">`,
      '  <error>',
      `    Skill with id "${skillId}" was not found in the current registry.`,
      '  </error>',
      '</skill_context>',
    ].join('\n');
  }

  return [
    `<skill_context id="${skill.skillId}">`,
    `  <description>${skill.description}</description>`,
    `  <skill_root>${path.dirname(skill.sourcePath)}</skill_root>`,
    '  <instructions>',
    stripYamlFrontMatter(skill.content).trim(),
    '  </instructions>',
    '</skill_context>',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeSelectionType(value: unknown): HitlSelectionType | { error: string } {
  if (value === undefined || value === null || value === '') {
    return 'single-select';
  }
  if (value === 'single-select' || value === 'multiple-select') {
    return value;
  }
  return { error: 'type must be one of single-select or multiple-select' };
}

function normalizeStructuredQuestion(rawQuestion: unknown, questionIndex: number): HitlInputQuestion | string {
  const pathPrefix = `questions[${questionIndex}]`;
  if (!isRecord(rawQuestion)) {
    return `Error: ${pathPrefix} must be an object`;
  }

  const header = typeof rawQuestion.header === 'string' ? rawQuestion.header.trim() : '';
  if (!header) {
    return `Error: ${pathPrefix}.header is required`;
  }

  const id = typeof rawQuestion.id === 'string' ? rawQuestion.id.trim() : '';
  if (!id) {
    return `Error: ${pathPrefix}.id is required`;
  }

  const question = typeof rawQuestion.question === 'string' ? rawQuestion.question.trim() : '';
  if (!question) {
    return `Error: ${pathPrefix}.question is required`;
  }

  if (!Array.isArray(rawQuestion.options)) {
    return `Error: ${pathPrefix}.options must be an array`;
  }

  if (rawQuestion.options.length < 2) {
    return `Error: ${pathPrefix}.options must include at least two options`;
  }

  const optionIds = new Set<string>();
  const options: HitlInputOption[] = [];
  for (let optionIndex = 0; optionIndex < rawQuestion.options.length; optionIndex += 1) {
    const rawOption = rawQuestion.options[optionIndex];
    const optionPath = `${pathPrefix}.options[${optionIndex}]`;
    if (!isRecord(rawOption)) {
      return `Error: ${optionPath} must be an object`;
    }

    const optionId = typeof rawOption.id === 'string' ? rawOption.id.trim() : '';
    if (!optionId) {
      return `Error: ${optionPath}.id is required`;
    }
    if (optionIds.has(optionId)) {
      return `Error: ${optionPath}.id must be unique within the question`;
    }
    optionIds.add(optionId);

    const label = typeof rawOption.label === 'string' ? rawOption.label.trim() : '';
    if (!label) {
      return `Error: ${optionPath}.label is required`;
    }

    if (rawOption.description !== undefined && typeof rawOption.description !== 'string') {
      return `Error: ${optionPath}.description must be a string`;
    }

    options.push({
      id: optionId,
      label,
      ...(typeof rawOption.description === 'string' && rawOption.description.trim()
        ? { description: rawOption.description.trim() }
        : {}),
    });
  }

  return {
    header,
    id,
    question,
    options,
  };
}

function hitlIssueFromError(message: string): ToolValidationIssue {
  const pathMatch = message.match(/^([a-zA-Z0-9_$.[\]-]+)\s/);
  const pathValue = pathMatch?.[1] ?? '$';
  return {
    path: pathValue,
    code: message.includes('required') ? 'missing_required' : 'invalid_type',
    message,
  };
}

function formatHitlValidationFailure(toolName: BuiltInToolName, error: string): string {
  const message = error.replace(/^Error:\s*/, '');
  const issue = hitlIssueFromError(message);
  return formatToolValidationFailureArtifact({
    toolName,
    validation: {
      valid: false,
      error: issue.message,
      issues: [issue],
      corrections: [],
    },
  });
}

function normalizeHitlInput(args: Record<string, unknown>): {
  type: HitlSelectionType;
  allowSkip: boolean;
  questions: HitlInputQuestion[];
} | string {
  const selectionType = normalizeSelectionType(args.type);
  if (typeof selectionType === 'object') {
    return `Error: ${selectionType.error}`;
  }

  if (args.allowSkip !== undefined && typeof args.allowSkip !== 'boolean') {
    return 'Error: allowSkip must be a boolean';
  }
  const allowSkip = args.allowSkip === true;

  if (!Array.isArray(args.questions)) {
    return 'Error: questions must be an array';
  }
  if (args.questions.length === 0) {
    return 'Error: questions must include at least one question';
  }

  const questions: HitlInputQuestion[] = [];
  for (let questionIndex = 0; questionIndex < args.questions.length; questionIndex += 1) {
    const normalizedQuestion = normalizeStructuredQuestion(args.questions[questionIndex], questionIndex);
    if (typeof normalizedQuestion === 'string') {
      return normalizedQuestion;
    }
    questions.push(normalizedQuestion);
  }
  return {
    type: selectionType,
    allowSkip,
    questions,
  };
}

async function createHitlExecutor(toolName: BuiltInToolName, _options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  const normalized = normalizeHitlInput(args);
  if (typeof normalized === 'string') {
    return formatHitlValidationFailure(toolName, normalized);
  }

  const pendingResult: PendingHitlToolResult = {
    ok: false,
    pending: true,
    status: 'pending',
    confirmed: false,
    requestId: typeof context?.toolCallId === 'string' ? context.toolCallId : '',
    type: normalized.type,
    allowSkip: normalized.allowSkip,
    questions: normalized.questions,
  };

  return JSON.stringify(pendingResult, null, 2);
}

async function createShellExecutor(_options: BuiltInExecutorOptions, args: Record<string, unknown>, context?: LLMToolExecutionContext): Promise<string> {
  try {
    throwIfAborted(context?.abortSignal);
  } catch (error) {
    return `Error: shell_cmd failed - ${error instanceof Error ? error.message : String(error)}`;
  }

  const command = String(args.command ?? '').trim();
  if (!command) {
    return 'Error: shell_cmd failed - command is required';
  }

  const trustedWorkingDirectory = getTrustedWorkingDirectory(context);
  const requestedDirectory = typeof args.directory === 'string' && args.directory.trim()
    ? resolveScopedPath(args.directory, trustedWorkingDirectory)
    : trustedWorkingDirectory;
  const parameters = Array.isArray(args.parameters)
    ? args.parameters.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const timeoutMs = clamp(Number(args.timeout ?? DEFAULT_SHELL_TIMEOUT_MS), 1000, DEFAULT_SHELL_TIMEOUT_MS);
  const outputFormat = String(args.output_format ?? 'markdown') === 'json' ? 'json' : 'markdown';
  const outputDetail = String(args.output_detail ?? 'minimal') === 'full' ? 'full' : 'minimal';

  return await new Promise<string>((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(command, parameters, {
      cwd: requestedDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const cleanupAbortRelay = relayAbortSignal(context?.abortSignal, (reason) => {
      aborted = true;
      child.kill('SIGTERM');
      stderr += `${stderr ? '\n' : ''}${createAbortError(reason).message}`;
    });

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      cleanupAbortRelay();
      clearTimeout(timer);
      resolvePromise(`Error: shell_cmd failed - ${error.message}`);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      cleanupAbortRelay();
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (outputFormat === 'json') {
        resolvePromise(JSON.stringify({
          exit_code: code,
          stdout,
          stderr,
          aborted,
          timed_out: timedOut,
          duration_ms: durationMs,
          signal,
        }, null, 2));
        return;
      }

      const preview = outputDetail === 'full' ? stdout : stdout.slice(0, 4096);
      resolvePromise([
        `status: ${code === 0 && !timedOut && !aborted ? 'success' : 'failed'}`,
        `exit_code: ${code}`,
        `aborted: ${aborted}`,
        `timed_out: ${timedOut}`,
        preview ? `stdout:\n${preview}` : 'stdout:\n',
        stderr ? `stderr:\n${outputDetail === 'full' ? stderr : stderr.slice(0, 4096)}` : 'stderr:\n',
      ].join('\n'));
    });
  });
}

export function createBuiltInExecutors(options: BuiltInExecutorOptions): Record<BuiltInToolName, BuiltInExecutor> {
  return {
    shell_cmd: (args, context) => createShellExecutor(options, args, context),
    load_skill: (args) => createLoadSkillExecutor(options, args),
    human_intervention_request: (args, context) => createHitlExecutor('human_intervention_request', options, args, context),
    ask_user_question: (args, context) => createHitlExecutor('ask_user_question', options, args, context),
    ask_user_input: (args, context) => createHitlExecutor('ask_user_input', options, args, context),
    web_fetch: (args, context) => createWebFetchExecutor(options, args, context),
    read_file: (args, context) => createReadFileExecutor(options, args, context),
    write_file: (args, context) => createWriteFileExecutor(options, args, context),
    list_files: (args, context) => createListFilesExecutor(options, args, context),
    search_files: (args, context) => createSearchFilesExecutor(options, args, context),
    create_directory: (args, context) => createDirectoryExecutor(options, args, context),
    path_exists: (args, context) => createPathExistsExecutor(options, args, context),
  };
}
