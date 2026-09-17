import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink as createSymbolicLink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchWorkspaceText } from '../lib/workspace-text-search.mts';
import { WorkspaceRequestError } from '../lib/workspace-file-paths.mts';
import { createWorkspaceFileSearchApi } from '../lib/workspace-file-search-preload.cts';
import { registerWorkspaceFileIpcHandlers } from '../lib/workspace-file-ipc.mts';
import { workspaceTextSearchRequest, workspaceTextSearchResult } from '../shared/workspace-text-search';
import { loadForgeConfiguration } from './forge-test-helpers';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

async function fixture(run: (root: string, file: (path: string, content?: string | Buffer) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'cheshi-text-search-'));
  const file = async (path: string, content: string | Buffer = 'test') => {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  };
  try { await run(root, file); } finally { await rm(root, { recursive: true, force: true }); }
}

function git(root: string, ...args: string[]) { return execFileSync('git', ['-c', 'core.safecrlf=false', ...args], { cwd: root, encoding: 'utf8' }); }

async function seed(root: string, file: (path: string, content?: string | Buffer) => Promise<void>) {
  git(root, 'init', '--quiet');
  await file('.gitignore', 'ignored/\n');
  await file('README.md', '# Title\nhello World\n');
  await file('src/app.ts', '﻿const greeting = "Hello";\r\n  hello again hello\r\n');
  await file('src/nested/util.ts', 'export const world = 1;\n');
  await file('src/image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
  await file('node_modules/pkg/index.js', 'hello from a dependency\n');
  await file('dist/bundle.js', 'hello from build output\n');
  await file('ignored/note.txt', 'hello ignored\n');
  await createSymbolicLink(join(root, 'README.md'), join(root, 'link.md'));
}

test('finds matches with line and column positions in text files and skips ignored, generated and binary files', async () => {
  await fixture(async (root, file) => {
    await seed(root, file);
    const result = await searchWorkspaceText(root, { query: 'hello' });
    expect(result).toEqual({ searchedFiles: 4, truncated: false, matches: [
      { path: 'README.md', line: 2, column: 1, length: 5, text: 'hello World' },
      { path: 'src/app.ts', line: 1, column: 19, length: 5, text: 'const greeting = "Hello";' },
      { path: 'src/app.ts', line: 2, column: 3, length: 5, text: '  hello again hello' },
      { path: 'src/app.ts', line: 2, column: 15, length: 5, text: '  hello again hello' },
    ] });
    git(root, 'add', '.'); await rm(join(root, 'README.md'));
    expect((await searchWorkspaceText(root, { query: 'hello' })).matches.map(match => match.path)).toEqual(['src/app.ts', 'src/app.ts', 'src/app.ts']);
  });
});

test('honours case-sensitive and regex options and truncates at the match limit', async () => {
  await fixture(async (root, file) => {
    await seed(root, file);
    const sensitive = await searchWorkspaceText(root, { query: 'Hello', caseSensitive: true });
    expect(sensitive.matches.map(match => `${match.path}:${match.line}:${match.column}`)).toEqual(['src/app.ts:1:19']);
    const regex = await searchWorkspaceText(root, { query: 'w[o]rld\\b', regex: true });
    expect(regex.matches.map(match => `${match.path}:${match.line}`)).toEqual(['README.md:2', 'src/nested/util.ts:1']);
    expect((await searchWorkspaceText(root, { query: 'w[o]rld' })).matches).toEqual([]);
    const limited = await searchWorkspaceText(root, { query: 'hello', limit: 2 });
    expect(limited.truncated).toBe(true); expect(limited.matches).toHaveLength(2);
    const empty = await searchWorkspaceText(root, { query: '^', regex: true, limit: 3 });
    expect(empty.matches.map(match => match.length)).toEqual([1, 1, 1]);
  });
});

test('searches non-Git workspaces and rejects invalid requests with a 400 workspace error', async () => {
  await fixture(async (root, file) => {
    await file('notes/todo.txt', 'hello there\n'); await file('node_modules/dep.js', 'hello dep\n');
    expect((await searchWorkspaceText(root, { query: 'hello' })).matches.map(match => match.path)).toEqual(['notes/todo.txt']);
    for (const request of ['hello', { query: '' }, { query: '(', regex: true }, { query: 'a', limit: 0 }, { query: 'a', regex: 'yes' }]) {
      await assert.rejects(searchWorkspaceText(root, request), (error: unknown) => error instanceof WorkspaceRequestError && error.status === 400);
    }
  });
});

test('validates request and response boundaries and routes text searches through IPC', async () => {
  expect(workspaceTextSearchRequest({ query: 'a b' })).toEqual({ query: 'a b', caseSensitive: false, regex: false, limit: 2_000 });
  for (const value of [null, {}, { query: 'x'.repeat(501) }, { query: 'bad\0query' }, { query: 'a', limit: 5_001 }, { query: 'a', caseSensitive: 1 }]) {
    expect(() => workspaceTextSearchRequest(value)).toThrow();
  }
  const valid = { matches: [{ path: 'src/a.ts', line: 1, column: 2, length: 3, text: 'abc' }], searchedFiles: 1, truncated: false };
  expect(workspaceTextSearchResult(valid)).toEqual(valid);
  for (const match of [{ ...valid.matches[0], path: '../a.ts' }, { ...valid.matches[0], path: '/a.ts' }, { ...valid.matches[0], line: 0 },
    { ...valid.matches[0], column: 1.5 }, { ...valid.matches[0], text: null }]) {
    expect(() => workspaceTextSearchResult({ ...valid, matches: [match] })).toThrow(/Invalid text search/);
  }
  expect(() => workspaceTextSearchResult({ ...valid, truncated: 'true' })).toThrow();
  expect(() => workspaceTextSearchResult({ ...valid, searchedFiles: -1 })).toThrow();
  const calls: unknown[][] = [];
  const api = createWorkspaceFileSearchApi({ invoke: async (...args: unknown[]) => { calls.push(args); return valid; } });
  expect(await api.searchWorkspaceText({ query: 'abc', regex: true })).toEqual(valid);
  expect(calls).toEqual([['cheshi:search-workspace-text', { query: 'abc', caseSensitive: false, regex: true, limit: 2_000 }]]);
  await assert.rejects(api.searchWorkspaceText({ query: '' }), /Text search/);
  await fixture(async (root, file) => {
    await file('entry.txt', 'needle\n');
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    registerWorkspaceFileIpcHandlers({ workspaceRoot: root, ipcMain: { handle: (name, handler) => { handlers.set(name, handler); } },
      clipboard: { writeText() {} }, shell: { async trashItem() {} } });
    const handler = handlers.get('cheshi:search-workspace-text');
    assert.ok(handler);
    const result = await handler({} as IpcMainInvokeEvent, { query: 'needle' });
    expect(result.matches).toEqual([{ path: 'entry.txt', line: 1, column: 1, length: 6, text: 'needle' }]);
    await assert.rejects(async () => handler({} as IpcMainInvokeEvent, null), /Text search/);
  });
  const config = await loadForgeConfiguration();
  const ignore = config.packagerConfig.ignore;
  assert.ok(typeof ignore === 'function');
  expect(ignore('/desktop/lib/workspace-text-search.mts')).toBe(false);
  expect(ignore('/desktop/shared/workspace-text-search.ts')).toBe(false);
});
