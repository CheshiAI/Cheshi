import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { CODEX_UPDATE_CHANNEL, type CodexUpdateApi } from '../shared/codex-update.ts';

test('bundled preload exposes Codex update calls and cleans up state subscriptions without leaking IPC events', async () => {
  let api: CodexUpdateApi | undefined;
  const calls: unknown[][] = [];
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: 'darwin', argv: [] }, window: { addEventListener() {} }, document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_key: string, value: CodexUpdateApi) { api = value; } },
        ipcRenderer: {
          sendSync() { return { workspaceName: 'Project', workspaceRoot: '/project' }; },
          async invoke(...args: unknown[]) { calls.push(args); return null; },
          on(channel: string, listener: (event: unknown, value: unknown) => void) { listeners.set(channel, listener); },
          removeListener(channel: string, listener: (event: unknown, value: unknown) => void) {
            if (listeners.get(channel) === listener) listeners.delete(channel);
          },
        },
      };
    },
  });
  assert.ok(api);
  const initialListeners = new Map(listeners);
  assert.equal(initialListeners.has(`${CODEX_UPDATE_CHANNEL}:changed`), false);
  await api.getCodexUpdate();
  await api.checkCodexUpdate();
  await api.installCodexUpdate();
  await api.syncWorkerCodex();
  assert.deepEqual(calls, [[`${CODEX_UPDATE_CHANNEL}:get`], [`${CODEX_UPDATE_CHANNEL}:check`], [`${CODEX_UPDATE_CHANNEL}:install`], [`${CODEX_UPDATE_CHANNEL}:workers`]]);
  const received: unknown[] = [];
  const unsubscribe = api.onCodexUpdateChanged(state => received.push(state));
  const state = { installedVersion: '0.163.0', availableVersion: '0.163.0', managed: true, busy: false, phase: 'idle', workers: { versions: ['0.163.0'], pending: 0, waiting: 0, errors: [] }, detail: 'Ready', error: null, revision: 1 };
  listeners.get(`${CODEX_UPDATE_CHANNEL}:changed`)?.({ privateEvent: true }, state);
  assert.deepEqual(received, [state]);
  unsubscribe();
  assert.equal(listeners.has(`${CODEX_UPDATE_CHANNEL}:changed`), false);
  assert.deepEqual(listeners, initialListeners);
});
