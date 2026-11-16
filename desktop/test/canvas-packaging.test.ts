import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import forgeConfig from '../../forge.config.mts';
import type { CanvasApi } from '../shared/canvas.ts';

test('packaging retains the native canvas service and its local path helpers', async () => {
  const ignore = (await forgeConfig()).packagerConfig?.ignore;
  assert.equal(typeof ignore, 'function');
  if (typeof ignore !== 'function') return;
  for (const file of ['canvas', 'canvas/canvas-ipc.mts', 'canvas/canvas-documents.mts', 'canvas/canvas-session.mts',
    'canvas/canvas-library.mts', 'canvas/canvas-history.mts', 'local-history-lock.mts', 'workspace-file-paths.mts']) {
    assert.equal(ignore(`/desktop/lib/${file}`), false, file);
  }
  for (const file of ['canvas/canvas-preload.cts', 'canvas/unexpected.mts', 'canvas/canvas-ipc.mts/nested', 'canvas-ipc.mts', 'canvas-documents.mts', 'canvas-session.mts']) {
    assert.equal(ignore(`/desktop/lib/${file}`), true, file);
  }
  assert.equal(ignore('/config/workspace-storage.mts'), false);
  assert.equal(ignore('/vendor'), true);
  assert.equal(ignore('/vendor/open-pencil/src/App.vue'), true);
});

test('sandboxed preload transports design bytes and revision without modification', async () => {
  let api: CanvasApi | undefined;
  const calls: unknown[][] = [];
  const data = new Uint8Array([102, 105, 103, 45, 107, 105, 119, 105]);
  const document = { path: 'design.fig', revision: 'revision', data };
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: process.platform, argv: [] },
    window: { addEventListener() {} }, document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        ipcRenderer: { on() {}, sendSync: () => ({ workspaceName: 'Test', workspaceRoot: '/test' }),
          invoke: async (...args: unknown[]) => { calls.push(args); return document; } },
        contextBridge: { exposeInMainWorld(key: string, value: { canvas?: CanvasApi }) {
          if (key === 'cheshiDesktop') api = value.canvas;
        } },
      };
    },
  });
  assert.ok(api);
  assert.equal(await api.read('design.fig'), document);
  const request = { path: document.path, expectedRevision: document.revision, data };
  await api.save(request);
  await api.lastDocument();
  await api.rememberDocument('design.fig');
  await api.rememberDocument(null);
  await api.list();
  await api.history('design.fig');
  await api.readVersion('design.fig', 'version-id');
  const checkpoint = { path: 'design.fig', description: 'Before agent work' };
  const restore = { path: 'design.fig', versionId: 'version-id', expectedRevision: 'revision' };
  await api.checkpoint(checkpoint);
  await api.restore(restore);
  await api.chooseRoot();
  await api.newPath('next');
  const rename = { path: 'design.fig', name: 'renamed', expectedRevision: 'revision' };
  await api.rename(rename);
  assert.deepEqual(calls, [['cheshi:canvas:read', 'design.fig'], ['cheshi:canvas:save', request],
    ['cheshi:canvas:last-document'], ['cheshi:canvas:remember-document', 'design.fig'], ['cheshi:canvas:remember-document', null],
    ['cheshi:canvas:list'], ['cheshi:canvas:history', 'design.fig'], ['cheshi:canvas:read-version', 'design.fig', 'version-id'],
    ['cheshi:canvas:checkpoint', checkpoint], ['cheshi:canvas:restore', restore],
    ['cheshi:canvas:choose-root'], ['cheshi:canvas:new-path', 'next'], ['cheshi:canvas:rename', rename]]);
});
