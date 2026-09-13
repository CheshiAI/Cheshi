import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { ShowcaseApi, ShowcaseState } from '../shared/showcase.ts';

test('built sandboxed preload exposes only typed Showcase layout and navigation with removable state subscription', async () => {
  let api: ShowcaseApi | undefined;
  const calls: unknown[][] = [];
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    URL, process: { platform: process.platform }, window: { addEventListener() {} }, document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(key: string, value: { showcase?: ShowcaseApi }) {
          if (key === 'cheshiDesktop') api = value.showcase;
        } },
        ipcRenderer: {
          sendSync() { return { workspaceName: 'Test', workspaceRoot: '/test' }; },
          async invoke(...args: unknown[]) { calls.push(args); },
          on(channel: string, handler: (event: unknown, value: unknown) => void) { listeners.set(channel, handler); },
          removeListener(channel: string) { listeners.delete(channel); },
        },
      };
    },
  });
  assert.ok(api);
  const request = { page: 'gallery' as const, visible: true, bounds: { x: 320, y: 60, width: 800, height: 500 } };
  await api.setView(request);
  await api.navigate('reload');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['cheshi:showcase:view', request], ['cheshi:showcase:navigate', 'reload']]);
  await assert.rejects(api.setView({ ...request, visible: 'false' } as unknown as typeof request));
  assert.equal(calls.length, 2);
  const states: ShowcaseState[] = [];
  const unsubscribe = api.onState(state => states.push(state));
  const state = { page: 'gallery', url: 'https://developers.openai.com/showcase', title: 'Showcase',
    loading: false, error: null, canGoBack: false, canGoForward: false };
  listeners.get('cheshi:showcase:state')?.({}, state);
  assert.deepEqual(JSON.parse(JSON.stringify(states)), [state]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});
