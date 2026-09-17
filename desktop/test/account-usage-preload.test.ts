import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import test from 'node:test';
import type { UsagePopoverApi } from '../shared/account-usage-popover.ts';

test('sandboxed usage preload exposes only usage reads, sizing and allowlisted actions', async () => {
  const source = readFileSync(new URL('../runtime/account-usage-preload.cjs', import.meta.url), 'utf8');
  const calls: unknown[] = [];
  const exposed = new Map<string, UsagePopoverApi>();
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  new Script(source).runInNewContext({ require(name: string) {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld(key: string, api: UsagePopoverApi) { exposed.set(key, api); } },
      ipcRenderer: {
        async invoke(...args: unknown[]) { calls.push(args); return null; },
        on(topic: string, listener: (event: unknown, value: unknown) => void) { listeners.set(topic, listener); },
        removeListener(topic: string, listener: unknown) { assert.equal(listeners.get(topic), listener); listeners.delete(topic); },
      },
    };
  } });
  assert.deepEqual([...exposed.keys()], ['cheshiUsagePopover']);
  const api = exposed.get('cheshiUsagePopover')!;
  assert.deepEqual(Object.keys(api).sort(), ['action', 'onChange', 'read', 'resize']);
  await api.read(); await api.resize(400); await api.action('show');
  assert.deepEqual(calls, [['cheshi:usage-popover:read'], ['cheshi:usage-popover:resize', 400], ['cheshi:usage-popover:action', 'show']]);
  let received: unknown;
  const off = api.onChange(value => { received = value; });
  const payload = { revision: 1, snapshot: null, dark: true };
  listeners.get('cheshi:usage-popover:changed')!({ secret: 'ipc event must not cross bridge' }, payload);
  assert.equal(received, payload);
  off(); assert.equal(listeners.size, 0);
});
