import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceEditorSessionStore } from '../lib/workspace-editor-session.mts';
import { registerWorkspaceFileIpcHandlers } from '../lib/workspace-file-ipc.mts';
import { parseWorkspaceEditorSession, type WorkspaceEditorSession } from '../shared/workspace-editor-session';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-editor-session-'));
  directories.push(directory);
  const filePath = path.join(directory, 'state', 'editor-session.json');
  return { directory, filePath, store: createWorkspaceEditorSessionStore(filePath) };
}
const session: WorkspaceEditorSession = {
  version: 1, paths: ['src/first.ts', '한글 파일.tsx'], selectedPath: '한글 파일.tsx',
};
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('workspace editor session storage', () => {
  test('restores the split ratio with tabs across application store instances', () => {
    const { filePath, store } = fixture();
    const saved = { ...session, splitRatio: 0.67 };
    store.write(saved);
    expect(createWorkspaceEditorSessionStore(filePath).read()).toEqual(saved);
  });

  test('keeps legacy sessions valid and rejects invalid ratios without erasing the saved session', () => {
    const { store } = fixture();
    store.write(session);
    expect(store.read()).toEqual(session);
    for (const splitRatio of [null, '0.6', NaN, Infinity, 0, 0.09, 0.91, 1]) {
      expect(() => store.write({ ...session, splitRatio })).toThrow(TypeError);
      expect(store.read()).toEqual(session);
    }
  });
  test('restores ordered tabs and the selected file across store instances', () => {
    const { filePath, store } = fixture();
    expect(store.read()).toBeNull();
    store.write(session);
    expect(createWorkspaceEditorSessionStore(filePath).read()).toEqual(session);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(session);
    expect(readdirSync(path.dirname(filePath))).toEqual(['editor-session.json']);
  });

  test('persists closing every tab and keeps workspaces isolated', () => {
    const first = fixture();
    const second = fixture();
    first.store.write(session);
    second.store.write({ version: 1, paths: ['other.ts'], selectedPath: 'other.ts' });
    const empty: WorkspaceEditorSession = { version: 1, paths: [], selectedPath: null };
    first.store.write(empty);
    expect(createWorkspaceEditorSessionStore(first.filePath).read()).toEqual(empty);
    expect(second.store.read()?.paths).toEqual(['other.ts']);
  });

  test('recovers malformed state without restoring untrusted paths', () => {
    const { filePath, store } = fixture();
    store.write(session);
    for (const contents of ['{invalid', 'null', JSON.stringify({ ...session, paths: ['../outside.ts'] })]) {
      writeFileSync(filePath, contents);
      expect(store.read()).toBeNull();
    }
    store.write(session);
    expect(store.read()).toEqual(session);
  });

  test('rejects invalid writes before replacing the previous state', () => {
    const { store } = fixture();
    store.write(session);
    expect(() => store.write({ ...session, selectedPath: 'not-open.ts' })).toThrow(TypeError);
    expect(store.read()).toEqual(session);
  });

  test('serializes rapid IPC writes so the most recent selection wins', () => {
    const { directory, filePath } = fixture();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerWorkspaceFileIpcHandlers({
      ipcMain: { handle: (channel, listener) => { handlers.set(channel, (...args) => listener({} as never, ...args)); } },
      workspaceRoot: directory, editorSessionPath: filePath,
      clipboard: { writeText: () => {} }, shell: { trashItem: async () => {} },
    });
    const write = handlers.get('cheshi:write-editor-session')!;
    for (let index = 0; index < 20; index++) {
      write({ version: 1, paths: [`file-${index}.ts`], selectedPath: `file-${index}.ts` });
    }
    expect(handlers.get('cheshi:read-editor-session')!()).toEqual({
      version: 1, paths: ['file-19.ts'], selectedPath: 'file-19.ts',
    });
    expect(readdirSync(path.dirname(filePath))).toEqual(['editor-session.json']);
  });
});

describe('workspace editor session validation', () => {
  test('accepts bounded relative paths and returns an independent snapshot', () => {
    const input: WorkspaceEditorSession = {
      version: 1, paths: Array.from({ length: 500 }, (_, index) => `src/${index}.ts`), selectedPath: null,
    };
    const parsed = parseWorkspaceEditorSession(input);
    input.paths.pop();
    expect(parsed.paths).toHaveLength(500);
  });

  test('rejects absolute paths, traversal, controls, duplicates and oversized input', () => {
    const invalidPaths = ['', '/etc/passwd', '../outside', 'src/../outside', './file', 'src//file',
      'src/', 'C:/file', 'C:\\file', '\\\\server\\file', 'src\u0000/file', 'src\nfile', 'x'.repeat(4097)];
    for (const invalidPath of invalidPaths) {
      expect(() => parseWorkspaceEditorSession({ version: 1, paths: [invalidPath], selectedPath: null })).toThrow(TypeError);
    }
    for (const value of [null, [], {}, { ...session, version: 2 }, { ...session, selectedPath: undefined },
      { ...session, paths: ['one.ts', 'one.ts'] }, { ...session, contents: 'never store drafts' },
      { version: 1, paths: Array.from({ length: 501 }, (_, index) => `${index}.ts`), selectedPath: null }]) {
      expect(() => parseWorkspaceEditorSession(value)).toThrow(TypeError);
    }
  });
});
