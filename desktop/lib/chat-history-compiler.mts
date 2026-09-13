import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ChatHistoryFileReference, ChatHistoryItemKind } from '../shared/chat-history-search.ts';
import { recordValue, stringValue } from './codex-service-utils.mts';

type JsonObject = Record<string, unknown>;
const FILE_LOCATION_SUFFIX = /(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/u;
const EXTENSIONLESS_FILE_NAMES = new Set([
  'Dockerfile', 'Makefile', 'makefile', 'GNUmakefile', 'BSDmakefile', 'Procfile',
  'Gemfile', 'Rakefile', 'Brewfile', 'Justfile', 'justfile', 'Vagrantfile', 'LICENSE', 'README',
]);
const BARE_FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'xml', 'md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'csv', 'tsv',
  'sql', 'graphql', 'gql', 'py', 'pyi', 'ipynb', 'rb', 'rake', 'php', 'go', 'rs', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx',
  'm', 'mm', 'swift', 'kt', 'kts', 'java', 'scala', 'cs', 'fs', 'fsx', 'dart', 'lua', 'luau', 'r', 'sh', 'bash', 'zsh', 'fish',
  'ps1', 'bat', 'cmd', 'lock', 'lockb', 'properties', 'proto', 'prisma', 'tf', 'tfvars', 'gradle', 'sbt', 'cmake',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'wasm',
]);
const BARE_DOTFILE_NAMES = new Set([
  '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', '.npmrc', '.nvmrc', '.yarnrc', '.dockerignore',
  '.eslintrc', '.eslintignore', '.prettierrc', '.prettierignore', '.babelrc', '.browserslistrc', '.bashrc', '.zshrc',
]);
const COMMAND_NAMES = new Set([
  'wc', 'cat', 'head', 'tail', 'sed', 'awk', 'gawk', 'grep', 'rg', 'ag', 'find', 'fd', 'ls', 'stat', 'file', 'du',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'patch', 'xargs', 'readlink', 'realpath', 'tee', 'touch', 'cp', 'mv', 'rm',
  'git', 'bun', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'eslint', 'prettier', 'python', 'python3', 'ruby',
  'go', 'cargo', 'make', 'cmake', 'sh', 'bash', 'zsh', 'fish', 'env', 'sudo', 'command', 'nohup', 'time', 'cheshi-cli',
]);
export type ChatHistoryEntryKind = ChatHistoryItemKind;
export type ChatHistoryFileKind = ChatHistoryFileReference['kind'];
export type CompiledChatHistoryFile = ChatHistoryFileReference;

export interface CompiledChatHistoryEntry {
  turnId: string;
  itemId: string;
  kind: ChatHistoryEntryKind;
  text: string;
  files: CompiledChatHistoryFile[];
}

export interface CompiledChatHistoryThread {
  threadId: string;
  entries: CompiledChatHistoryEntry[];
  parentThreadId: string | null;
  forkedFromId: string | null;
}

function requireRecord(value: unknown, label: string): JsonObject {
  const record = recordValue(value);
  if (!record) throw new Error(`Invalid chat history ${label}.`);
  return record;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid chat history ${label}.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid chat history ${label}.`);
  return value;
}

function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  const id = stringValue(value);
  if (!id || !id.trim()) throw new Error(`Invalid chat history ${label}.`);
  return id;
}

/** Lexical only: history can refer to files that were moved or deleted. */
export function normalizeChatHistoryFilePath(
  value: unknown,
  cwd: string,
  baseDirectory = cwd,
): string | null {
  if (typeof value !== 'string' || !isAbsolute(cwd) || !isAbsolute(baseDirectory)) return null;
  let candidate = value.trim();
  if (/^[`'"<]/u.test(candidate) && /[`'">]$/u.test(candidate)) candidate = candidate.slice(1, -1).trim();
  candidate = candidate.replace(FILE_LOCATION_SUFFIX, '');
  if (!candidate || /[\u0000-\u001f\u007f]/u.test(candidate)
    || /^(?:[a-z][a-z\d+.-]*:|~)/iu.test(candidate)
    || /[\\?#]/u.test(candidate)) return null;
  const workspace = resolve(cwd);
  const path = relative(workspace, resolve(baseDirectory, candidate));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
  return path.split(sep).join('/');
}

function looksLikeFile(value: string, explicit: boolean): boolean {
  const candidate = value.replace(FILE_LOCATION_SUFFIX, '');
  const basename = candidate.slice(candidate.lastIndexOf('/') + 1);
  if (/[=;|{}$!<>\r\n]/u.test(candidate)) return false;
  if (EXTENSIONLESS_FILE_NAMES.has(basename)) return true;
  if (!explicit && !candidate.includes('/')) {
    // A bare dot can also denote a property, CSS selector, version or hostname.
    // Unknown extensions remain searchable when quotes, links or a directory establish a path.
    const extension = /\.([\p{L}\p{N}_-]+)$/u.exec(basename)?.[1]?.toLowerCase();
    return BARE_DOTFILE_NAMES.has(basename) || /^\.env(?:\.[\p{L}\p{N}_-]+)*$/u.test(basename)
      || (extension !== undefined && BARE_FILE_EXTENSIONS.has(extension));
  }
  return /(?:^|\/)(?:\.[\p{L}\p{N}_-]+|[^/]+\.[\p{L}\p{N}_-]+)$/u.test(candidate)
    // Without a filename extension, require one path token: quoted prose can contain slashes too.
    || (explicit && /^[\p{L}\p{M}\p{N}_.@()+/-]+$/u.test(candidate)
      && candidate.includes('/') && basename.length > 0);
}

function isQuotedCommand(value: string): boolean {
  const expression = value.trim().replace(/^\$\s+/u, '')
    .replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"']+)\s+)*/u, '');
  const command = /^(\S+)\s+\S/u.exec(expression)?.[1];
  if (!command) return false;
  // Only recognize command heads, not names embedded in paths such as docs/cat notes.md.
  return COMMAND_NAMES.has(command.replace(/^\/(?:usr\/(?:local\/)?)?bin\//u, ''));
}

function mentionedFiles(text: string, cwd: string, baseDirectory: string): CompiledChatHistoryFile[] {
  const paths = new Set<string>();
  const append = (candidate: string, explicit = false) => {
    if (!looksLikeFile(candidate, explicit)) return;
    const path = normalizeChatHistoryFilePath(candidate, cwd, baseDirectory);
    if (path) paths.add(path);
  };
  // Mask complete delimited expressions, including URLs, before examining bare words.
  let remaining = text.replace(/\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^()\r\n]*(?:\([^()\r\n]*\)[^()\r\n]*)*))\)/gu, (_match, angle: string | undefined, plain: string | undefined) => {
    const target = (angle ?? plain ?? '').replace(/\s+["'][^"']*["']\s*$/u, '').trim();
    try {
      append(decodeURI(target), true);
    } catch {
      append(target, true);
    }
    return ' ';
  });
  remaining = remaining.replace(/`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'/gu, (_match, code: string | undefined, double: string | undefined, single: string | undefined) => {
    const value = code ?? double ?? single ?? '';
    if (isQuotedCommand(value)) {
      // Examine the command's contents as text so quoted filenames stay intact.
      // This only records mentions; it never executes commands or infers successful reads/changes.
      for (const file of mentionedFiles(value, cwd, baseDirectory)) paths.add(file.path);
    } else append(value, true);
    return ' ';
  });
  remaining = remaining.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>]+|\b[^\s<>@]+@[^\s<>@]+/giu, ' ');
  for (const match of remaining.matchAll(/(?:\.{0,2}\/)?[\p{L}\p{N}_.@+/-]+(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)?/gu)) {
    append(match[0].replace(/[.,]+$/u, ''));
  }
  return [...paths].sort().map((path) => ({ path, kind: 'mentioned' }));
}

function mergeFiles(files: CompiledChatHistoryFile[]): CompiledChatHistoryFile[] {
  const rank: Record<ChatHistoryFileKind, number> = { mentioned: 0, read: 1, changed: 2 };
  const unique = new Map<string, CompiledChatHistoryFile>();
  for (const file of files) {
    const previous = unique.get(file.path);
    if (!previous || rank[file.kind] > rank[previous.kind]) unique.set(file.path, file);
  }
  return [...unique.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function userText(content: unknown): string {
  const parts = requireArray(content, 'user content');
  return parts.map((value) => {
    const part = requireRecord(value, 'user content part');
    if (part.type === 'text') return requireText(part.text, 'user text');
    if (part.type === 'mention') return stringValue(part.name) ? `@${String(part.name)}` : '';
    if (part.type === 'skill') return stringValue(part.name) ? `$${String(part.name)}` : '';
    // Image/audio payloads and internal provider fields are never copied into the index.
    return '';
  }).filter(Boolean).join('\n');
}

function statusText(item: JsonObject, turn: JsonObject): string {
  const status = stringValue(item.status);
  if (status === 'inProgress' && (turn.status === 'interrupted' || turn.status === 'failed')) return turn.status;
  return status ?? 'unknown';
}

function fileChangeContent(item: JsonObject, cwd: string, baseDirectory: string): { text: string; files: CompiledChatHistoryFile[] } {
  const values = Array.isArray(item.changes)
    ? item.changes.map((value): [string | null, unknown] => [null, value])
    : Object.entries(requireRecord(item.changes, 'file changes'));
  const lines: string[] = [];
  const files: CompiledChatHistoryFile[] = [];
  const referenceKind = item.status === 'completed' ? 'changed' : 'mentioned';
  for (const [key, value] of values) {
    const change = requireRecord(value, 'file change');
    const rawPath = key ?? requireText(change.path, 'file change path');
    const kindRecord = recordValue(change.kind);
    const kind = stringValue(kindRecord?.type) ?? stringValue(change.kind) ?? stringValue(change.type);
    if (kind !== 'add' && kind !== 'delete' && kind !== 'update') throw new Error('Invalid chat history file change kind.');
    const path = normalizeChatHistoryFilePath(rawPath, cwd, baseDirectory);
    if (path) files.push({ path, kind: referenceKind });
    lines.push(`${kind}: ${rawPath}`);
    const movePath = stringValue(kindRecord?.move_path) ?? stringValue(change.move_path);
    if (kind === 'update' && movePath) {
      const normalized = normalizeChatHistoryFilePath(movePath, cwd, baseDirectory);
      if (normalized) files.push({ path: normalized, kind: referenceKind });
      lines.push(`move: ${movePath}`);
    }
    const diff = stringValue(change.diff) ?? stringValue(change.unified_diff) ?? stringValue(change.content);
    if (diff) {
      lines.push(diff);
      files.push(...mentionedFiles(diff, cwd, baseDirectory));
    }
  }
  return { text: lines.join('\n'), files };
}

function activityContent(item: JsonObject, turn: JsonObject, cwd: string, baseDirectory: string): { text: string; files: CompiledChatHistoryFile[] } | null {
  const status = statusText(item, turn);
  switch (item.type) {
    case 'commandExecution': {
      const command = requireText(item.command, 'command');
      const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
      const exitCode = typeof item.exitCode === 'number' && Number.isInteger(item.exitCode)
        ? `\nexit code: ${item.exitCode}` : '';
      return { text: `Command · status: ${status}${exitCode}\n${command}${output ? `\n${output}` : ''}`, files: [] };
    }
    case 'fileChange': {
      const content = fileChangeContent(item, cwd, baseDirectory);
      return { ...content, text: `File changes · status: ${status}\n${content.text}` };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return { text: `Tool · status: ${status}\n${stringValue(item.server) ?? stringValue(item.namespace) ?? ''}\n${stringValue(item.tool) ?? ''}`, files: [] };
    case 'webSearch':
      return { text: `Web search\n${stringValue(item.query) ?? ''}`, files: [] };
    case 'imageGeneration':
      return { text: `Image generation · status: ${status}\n${stringValue(item.revisedPrompt) ?? ''}`, files: [] };
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return { text: `Agent activity · status: ${status}\n${stringValue(item.prompt) ?? stringValue(item.agentPath) ?? ''}`, files: [] };
    default:
      return null;
  }
}

function compileItem(item: JsonObject, turn: JsonObject, cwd: string, baseDirectory: string): { kind: ChatHistoryEntryKind; text: string; files: CompiledChatHistoryFile[] } | null {
  let kind: ChatHistoryEntryKind;
  let text: string;
  let files: CompiledChatHistoryFile[] = [];
  if (item.type === 'userMessage') {
    kind = 'user';
    text = userText(item.content);
  } else if (item.type === 'agentMessage' || item.type === 'plan') {
    kind = item.type === 'plan' ? 'plan' : 'assistant';
    text = requireText(item.text, `${kind} text`);
  } else {
    const content = activityContent(item, turn, cwd, baseDirectory);
    if (!content) return null;
    kind = 'activity';
    text = content.text;
    files = content.files;
  }
  text = text.trim();
  if (!text) return null;
  // File changes already supply exact paths and mentions from their diff content.
  // Re-parsing their display labels would split filenames containing spaces.
  const mentions = item.type === 'fileChange' ? [] : mentionedFiles(text, cwd, baseDirectory);
  return { kind, text, files: mergeFiles([...mentions, ...files]) };
}

/** Compiles only visible message/activity fields; never serializes provider records. */
export function compileChatHistoryThread(value: unknown, cwd: string): CompiledChatHistoryThread {
  if (!isAbsolute(cwd)) throw new Error('Chat history workspace must be an absolute path.');
  const response = requireRecord(value, 'response');
  const thread = Object.hasOwn(response, 'thread') ? requireRecord(response.thread, 'thread') : response;
  const threadId = optionalId(thread.id, 'thread id');
  if (!threadId) throw new Error('Invalid chat history thread id.');
  const turns = requireArray(thread.turns, 'turns');
  const baseDirectory = optionalId(thread.cwd, 'working directory') ?? cwd;
  if (!isAbsolute(baseDirectory)) throw new Error('Invalid chat history working directory.');
  const entries: CompiledChatHistoryEntry[] = [];
  const entryIds = new Set<string>();
  for (const [turnIndex, value] of turns.entries()) {
    const turn = requireRecord(value, 'turn');
    const turnId = optionalId(turn.id, 'turn id') ?? `turn-${turnIndex}`;
    const items = requireArray(turn.items, 'turn items');
    const append = (entry: CompiledChatHistoryEntry) => {
      const key = JSON.stringify([entry.turnId, entry.itemId]);
      if (entryIds.has(key)) throw new Error('Duplicate chat history source item.');
      entryIds.add(key);
      entries.push(entry);
    };
    for (const [itemIndex, value] of items.entries()) {
      const item = requireRecord(value, 'item');
      const itemId = optionalId(item.id, 'item id') ?? `${turnId}:${itemIndex}`;
      if (!stringValue(item.type)) throw new Error('Invalid chat history item type.');
      const itemCwd = optionalId(item.cwd, 'item working directory') ?? baseDirectory;
      if (!isAbsolute(itemCwd)) throw new Error('Invalid chat history item working directory.');
      const compiled = compileItem(item, turn, cwd, itemCwd);
      if (compiled) append({ turnId, itemId, ...compiled });
    }
    const message = stringValue(recordValue(turn.error)?.message);
    if (message) append({
      turnId, itemId: `${turnId}:error`, kind: 'activity',
      text: `Response failed\n${message}`, files: mentionedFiles(message, cwd, baseDirectory),
    });
  }
  return {
    threadId, entries,
    parentThreadId: optionalId(thread.parentThreadId, 'parent thread id'),
    forkedFromId: optionalId(thread.forkedFromId, 'fork source id'),
  };
}
