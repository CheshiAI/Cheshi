import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerGitIpcHandlers } from '../lib/git-ipc.mts';
import { GitService } from '../lib/git-service.mts';
import { registerLanguageServerIpcHandlers } from '../lib/language-server-ipc.mts';
import { LanguageServerManager } from '../lib/language-server-manager.mts';
import { registerLocalHistoryIpc } from '../lib/local-history-ipc.mts';
import { registerWorkspaceFileIpcHandlers } from '../lib/workspace-file-ipc.mts';
import type { WorkspaceFilesChangedEvent, WorkspaceFileVersion } from '../lib/workspace-file-types.mts';

function createIpcHarness() {
  type Handler = Parameters<IpcMain['handle']>[1];
  const handlers = new Map<string, Handler>();
  const event = { sender: { id: 1 } } as IpcMainInvokeEvent;
  const ipcMain: Pick<IpcMain, 'handle'> = {
    handle(channel, listener) {
      assert.equal(handlers.has(channel), false, `Duplicate IPC handler: ${channel}`);
      handlers.set(channel, listener);
    },
  };
  return {
    ipcMain,
    event,
    handlers,
    invoke(channel: string, ...args: unknown[]): unknown {
      const handler = handlers.get(channel);
      assert.ok(handler, `Missing IPC handler: ${channel}`);
      return handler(event, ...args);
    },
  };
}

function historyFile(): WorkspaceFileVersion {
  return { path: 'note.txt', name: 'note.txt', kind: 'file', fileKind: 'text', size: 6,
    modifiedAt: 100, revision: 'current-revision', hasBom: false, lineEnding: 'lf' };
}

test('checks local history senders before list, read and restore operations', async () => {
  const ipc = createIpcHarness();
  const calls: unknown[][] = [];
  let allowed = false;
  const entry = { id: 'history-id', path: 'note.txt', createdAt: 100, reason: 'saved' as const, size: 6 };
  const snapshot = { entry, content: 'saved\n', hasBom: false, lineEnding: 'lf' as const };
  const restored = { status: 'written' as const, file: historyFile() };
  registerLocalHistoryIpc({
    ipcMain: ipc.ipcMain,
    assertSender(event) {
      assert.equal(event, ipc.event);
      if (!allowed) throw new Error('Blocked history sender.');
      calls.push(['guard']);
    },
    service: {
      async list(filePath) { calls.push(['list', filePath]); return [entry]; },
      async read(filePath, id) { calls.push(['read', filePath, id]); return snapshot; },
      async restore(request) { calls.push(['restore', request]); return restored; },
    },
    onChanged(event) { calls.push(['changed', event]); },
  });
  for (const channel of ipc.handlers.keys()) {
    await assert.rejects(async () => { await ipc.invoke(channel, null); }, /Blocked history sender/u);
  }
  assert.deepEqual(calls, []);
  allowed = true;
  const request = { path: entry.path, id: entry.id, expectedRevision: 'current-revision' };
  assert.deepEqual(await ipc.invoke('cheshi:list-local-history', entry.path), [entry]);
  assert.equal(await ipc.invoke('cheshi:read-local-history', entry.path, entry.id), snapshot);
  assert.equal(await ipc.invoke('cheshi:restore-local-history', request), restored);
  assert.deepEqual(calls, [
    ['guard'], ['list', entry.path], ['guard'], ['read', entry.path, entry.id],
    ['guard'], ['restore', request], ['changed', { paths: [entry.path], overflow: false }],
  ]);
});

test('notifies workspace listeners only after a successful local history restore', async () => {
  const ipc = createIpcHarness();
  const changes: WorkspaceFilesChangedEvent[] = [];
  const file = historyFile();
  let status: 'written' | 'conflict' = 'conflict';
  let failure: Error | null = null;
  registerLocalHistoryIpc({
    ipcMain: ipc.ipcMain, assertSender() {},
    service: {
      async list() { return []; },
      async read() { throw new Error('Unused read.'); },
      async restore() {
        if (failure) throw failure;
        return { status, file };
      },
    },
    onChanged(event) { changes.push(event); },
  });
  const request = { path: file.path, id: 'history-id', expectedRevision: file.revision };
  assert.deepEqual(await ipc.invoke('cheshi:restore-local-history', request), { status: 'conflict', file });
  assert.deepEqual(changes, []);
  failure = new Error('History validation failed.');
  await assert.rejects(async () => { await ipc.invoke('cheshi:restore-local-history', request); }, failure);
  assert.deepEqual(changes, []);
  failure = null;
  status = 'written';
  assert.deepEqual(await ipc.invoke('cheshi:restore-local-history', request), { status: 'written', file });
  assert.deepEqual(changes, [{ paths: [file.path], overflow: false }]);
});

test('delegates workspace reads and single and batch saves to local history when enabled', async () => {
  const ipc = createIpcHarness();
  const calls: unknown[][] = [];
  const file = historyFile();
  const read = { file, content: 'saved\n', dataUrl: null };
  const written = { status: 'written' as const, file };
  const batchWritten = { status: 'written' as const, files: [file] };
  registerWorkspaceFileIpcHandlers({
    ipcMain: ipc.ipcMain, workspaceRoot: '/unused-history-workspace',
    clipboard: { writeText() {} }, shell: { async trashItem() {} },
    localHistory: {
      async readFile(filePath) { calls.push(['read', filePath]); return read; },
      async writeFile(request) { calls.push(['write', request]); return written; },
      async writeFiles(request) { calls.push(['batch', request]); return batchWritten; },
    },
  });
  const request = { path: file.path, content: 'updated\n', expectedRevision: file.revision };
  const batch = { files: [request] };
  assert.equal(await ipc.invoke('cheshi:read-workspace-file', file.path), read);
  assert.equal(await ipc.invoke('cheshi:write-workspace-file', request), written);
  assert.equal(await ipc.invoke('cheshi:write-workspace-files', batch), batchWritten);
  assert.deepEqual(calls, [['read', file.path], ['write', request], ['batch', batch]]);
});

test('keeps Git IPC sender checks ahead of service calls and external URL handling', async () => {
  const ipc = createIpcHarness();
  const gitService = new GitService({ workspaceRoot: os.tmpdir() });
  let reads = 0;
  const historyReads: string[] = [];
  const commitDiffReads: Array<{ number: unknown; commitOid: unknown }> = [];
  const commitOid = 'a'.repeat(40);
  const commitDiff = { number: 12, path: null, headRefOid: commitOid, patch: '', binary: false, truncated: false };
  let allowed = false;
  const snapshot = { available: false, message: 'Test repository unavailable.' } as const;
  gitService.getSnapshot = async () => {
    reads += 1;
    return snapshot;
  };
  gitService.getBranchCommits = async (reference: string) => {
    historyReads.push(reference);
    return [];
  };
  gitService.getPullRequestDiff = async (number: unknown, commitOid?: unknown) => {
    commitDiffReads.push({ number, commitOid });
    return commitDiff;
  };
  const opened: string[] = [];
  const trashed: string[] = [];
  registerGitIpcHandlers({
    ipcMain: ipc.ipcMain,
    gitService,
    assertCheshiSender(event) {
      assert.equal(event, ipc.event);
      if (!allowed) throw new Error('Not the main renderer.');
    },
    shell: {
      async openExternal(url: string) { opened.push(url); },
      async trashItem(filePath: string) { trashed.push(filePath); },
    },
  });

  for (const channel of ipc.handlers.keys()) {
    await assert.rejects(async () => { await ipc.invoke(channel); }, /Not the main renderer/u);
  }
  assert.equal(reads, 0);
  assert.deepEqual(historyReads, []);
  assert.deepEqual(commitDiffReads, []);
  assert.deepEqual(opened, []);
  assert.deepEqual(trashed, []);

  allowed = true;
  assert.equal(await ipc.invoke('cheshi:get-git-snapshot'), snapshot);
  assert.equal(reads, 1);
  assert.deepEqual(await ipc.invoke('cheshi:get-git-branch-commits', 'refs/heads/main'), []);
  assert.deepEqual(historyReads, ['refs/heads/main']);
  assert.equal(await ipc.invoke('cheshi:get-github-pull-request-diff', 12, commitOid), commitDiff);
  assert.deepEqual(commitDiffReads, [{ number: 12, commitOid }]);
  for (const url of ['http://github.com/org/repo/pull/1', 'https://github.com.example.com/pull/1']) {
    await assert.rejects(async () => {
      await ipc.invoke('cheshi:open-github-pull-request', url);
    }, /https:\/\/github\.com/u);
  }
  assert.deepEqual(opened, []);
  const url = 'https://github.com/org/repo/pull/1';
  await ipc.invoke('cheshi:open-github-pull-request', url);
  assert.deepEqual(opened, [url]);
});

test('connects Git discard preview and confirmed targets to the service and Trash', async () => {
  const ipc = createIpcHarness();
  const gitService = new GitService({ workspaceRoot: os.tmpdir() });
  const targets = [{ path: 'new.txt', scope: 'working' }] as const;
  const preview = {
    files: [{ ...targets[0], oldPath: null, action: 'trash' as const }],
    revision: 'a'.repeat(64),
  };
  const request = { targets, confirmed: true, expectedRevision: preview.revision };
  const snapshot = { available: false, message: 'Test repository unavailable.' } as const;
  const trashed: string[] = [];
  const absolutePath = path.join(os.tmpdir(), targets[0].path);
  gitService.prepareDiscard = async (value: unknown) => {
    assert.deepEqual(value, { targets });
    return preview;
  };
  gitService.discardChanges = async (value: unknown, trashItem) => {
    assert.deepEqual(value, request);
    await trashItem(absolutePath);
    return snapshot;
  };
  registerGitIpcHandlers({
    ipcMain: ipc.ipcMain,
    gitService,
    assertCheshiSender(event) { assert.equal(event, ipc.event); },
    shell: {
      async openExternal() {},
      async trashItem(filePath: string) { trashed.push(filePath); },
    },
  });
  assert.equal(await ipc.invoke('cheshi:prepare-git-discard', { targets }), preview);
  assert.deepEqual(trashed, []);
  assert.equal(await ipc.invoke('cheshi:discard-git-changes', request), snapshot);
  assert.deepEqual(trashed, [absolutePath]);
});

test('keeps workspace IPC paths rooted in the configured workspace', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-workspace-ipc-'));
  try {
    writeFileSync(path.join(root, 'note.txt'), 'Workspace content.\n');
    const ipc = createIpcHarness();
    const copied: string[] = [];
    const trashed: string[] = [];
    registerWorkspaceFileIpcHandlers({
      ipcMain: ipc.ipcMain,
      workspaceRoot: root,
      clipboard: { writeText(value: string) { copied.push(value); } },
      shell: { async trashItem(value: string) { trashed.push(value); } },
    });

    const file = await ipc.invoke('cheshi:read-workspace-file', 'note.txt');
    assert.ok(typeof file === 'object' && file !== null && 'content' in file);
    assert.equal(file.content, 'Workspace content.\n');
    const copiedPath = await ipc.invoke('cheshi:copy-workspace-entry-full-path', 'note.txt');
    assert.equal(path.basename(String(copiedPath)), 'note.txt');
    assert.deepEqual(copied, [copiedPath]);
    await assert.rejects(async () => {
      await ipc.invoke('cheshi:delete-workspace-entry', '../outside.txt');
    }, /path|workspace/u);
    assert.deepEqual(trashed, []);
    await ipc.invoke('cheshi:delete-workspace-entry', 'note.txt');
    assert.deepEqual(trashed, [copiedPath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps language server IPC validation and executable selection callbacks connected', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cheshi-language-ipc-'));
  const manager = new LanguageServerManager({
    workspaceRoot: root,
    settingsPath: path.join(root, 'settings.json'),
    clientInfo: { name: 'cheshi-test', version: '0.0.0' },
    definitions: {},
    environment: { PATH: '' },
  });
  try {
    const ipc = createIpcHarness();
    let checks = 0;
    registerLanguageServerIpcHandlers({
      ipcMain: ipc.ipcMain,
      languageServerManager: manager,
      assertCheshiSender(event) {
        assert.equal(event, ipc.event);
        checks += 1;
      },
      async selectLanguageServerExecutable(event, language) {
        assert.equal(event, ipc.event);
        return { language };
      },
    });
    assert.deepEqual(await ipc.invoke('cheshi:get-language-servers'), manager.getStatuses());
    assert.equal(checks, 1);
    assert.deepEqual(
      await ipc.invoke('cheshi:select-language-server-executable', 'typescript'),
      { language: 'typescript' },
    );
    await assert.rejects(async () => {
      await ipc.invoke('cheshi:update-language-server-document', { language: 'missing' });
    }, /language|server/iu);
    assert.equal(checks, 2);
  } finally {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
