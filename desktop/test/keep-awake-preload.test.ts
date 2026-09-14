import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { KeepAwakeApi, KeepAwakeState } from '../shared/keep-awake.ts';
import { KEEP_AWAKE_CHANNEL } from '../shared/keep-awake.ts';

function bridge() {
  let api: KeepAwakeApi | undefined;
  let reply: unknown = { supported: true, enabled: false, error: null };
  const calls: unknown[][] = [];
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: 'darwin' },
    window: { addEventListener() {} }, document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_name: string, value: { keepAwake: KeepAwakeApi }) { api = value.keepAwake; } },
        ipcRenderer: {
          sendSync() { return { workspaceName: 'Project', workspaceRoot: '/project' }; },
          async invoke(...args: unknown[]) { calls.push(args); return reply; },
          on(channel: string, listener: (event: unknown, value: unknown) => void) { listeners.set(channel, listener); },
          removeListener(channel: string, listener: (event: unknown, value: unknown) => void) {
            if (listeners.get(channel) === listener) listeners.delete(channel);
          },
        },
      };
    },
  });
  assert.ok(api);
  return { api, calls, listeners, setReply(value: unknown) { reply = value; } };
}

test('keep awake exposes only get, set, and state notifications on fixed IPC channels', async () => {
  const { api, calls, listeners } = bridge();
  assert.equal((await api.get()).enabled, false);
  await api.set(true);
  await api.set(false);
  assert.deepEqual(calls, [[`${KEEP_AWAKE_CHANNEL}:get`], [`${KEEP_AWAKE_CHANNEL}:set`, true], [`${KEEP_AWAKE_CHANNEL}:set`, false]]);
  const received: KeepAwakeState[] = [];
  const unsubscribe = api.subscribe(state => received.push(state));
  listeners.get(`${KEEP_AWAKE_CHANNEL}:changed`)?.({ secret: 'private IPC event' }, { supported: true, enabled: true, error: null });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.enabled, true);
  assert.deepEqual(Object.keys(received[0] ?? {}), ['supported', 'enabled', 'error']);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test('keep awake rejects non-boolean requests before IPC and malformed responses', async () => {
  const { api, calls, setReply } = bridge();
  const setAtBoundary = api.set as (value: unknown) => Promise<KeepAwakeState>;
  for (const value of ['true', 1, null, {}]) await assert.rejects(() => setAtBoundary(value), /boolean/);
  assert.equal(calls.length, 0);
  for (const value of [null, { supported: true, enabled: 'true', error: null }, { supported: false, enabled: true, error: null }]) {
    setReply(value);
    await assert.rejects(() => api.get(), /Invalid keep-awake state/);
  }
});
