import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { KEEP_AWAKE_CHANNEL, type KeepAwakeApi } from '../shared/keep-awake.ts';

test('bundled preload exposes keep awake calls and cleans up state subscriptions without leaking IPC events', async () => {
  let api: KeepAwakeApi | undefined;
  const calls: unknown[][] = [];
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: 'darwin', argv: [] }, window: { addEventListener() {} }, document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_key: string, value: KeepAwakeApi) { api = value; } },
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
  await api.getKeepAwake();
  await api.setKeepAwake(true);
  await api.setKeepAwake(false);
  assert.deepEqual(calls, [[`${KEEP_AWAKE_CHANNEL}:get`], [`${KEEP_AWAKE_CHANNEL}:set`, true], [`${KEEP_AWAKE_CHANNEL}:set`, false]]);
  const received: unknown[] = [];
  const unsubscribe = api.onKeepAwakeChanged(state => received.push(state));
  const state = { supported: true, enabled: true, busy: false, error: null, revision: 1 };
  listeners.get(`${KEEP_AWAKE_CHANNEL}:changed`)?.({ privateEvent: true }, state);
  assert.deepEqual(received, [state]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});
