import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { CheshiDesktopApi } from '../frontend/src/cheshiDesktop.ts';

test('sandboxed preload preserves linked project paths and scoped operations', async () => {
  let api: CheshiDesktopApi | undefined;
  const calls: unknown[][] = [];
  const listeners = new Map<string, () => void>();
  vm.runInNewContext(readFileSync(new URL('../runtime/preload.cjs', import.meta.url), 'utf8'), {
    process: { platform: process.platform }, window: { addEventListener() {} }, document: { readyState: 'loading' },
    require(name: string) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(key: string, value: CheshiDesktopApi) { if (key === 'cheshiDesktop') api = value; } },
        ipcRenderer: {
          sendSync: () => ({ workspaceName: 'App', workspaceRoot: '/app' }),
          invoke: async (...args: unknown[]) => {
            calls.push(args);
            if (args[0] === 'cheshi:get-git-line-blame') return { status: 'uncommitted' };
            if (args[0] === 'cheshi:search-workspace-files') return { files: [{ path: '/plugin/same.ts', name: 'same.ts' }], truncated: false };
            return null;
          },
          on: (channel: string, listener: () => void) => listeners.set(channel, listener),
          removeListener: (channel: string) => listeners.delete(channel),
        } };
    },
  });
  assert.ok(api?.workspaceProjects);
  await api.workspaceProjects.add();
  await api.listWorkspaceDirectory('/plugin');
  await api.readWorkspaceFile('/plugin/same.ts');
  await api.getGitLineBlame({ path: '/plugin/same.ts', line: 1, content: 'hello' });
  assert.equal((await api.searchWorkspaceFiles('same')).files[0]?.path, '/plugin/same.ts');
  await api.workspaceProjects.invoke('plugin-id', 'cheshi:stage-git-paths', [['same.ts']]);
  await api.newTerminalSession('plugin-id');
  assert.deepEqual(calls.slice(0, 3), [
    ['cheshi:workspace-projects:add'], ['cheshi:list-workspace-directory', '/plugin'], ['cheshi:read-workspace-file', '/plugin/same.ts'],
  ]);
  assert.deepEqual(calls.at(-2), ['cheshi:workspace-projects:invoke', 'plugin-id', 'cheshi:stage-git-paths', [['same.ts']]]);
  assert.deepEqual(calls.at(-1), ['cheshi:new-terminal-session', 'plugin-id']);
  let updates = 0;
  const unsubscribe = api.workspaceProjects.onChanged(() => updates++);
  listeners.get('cheshi:workspace-projects-changed')?.();
  assert.equal(updates, 1);
  unsubscribe();
  assert.equal(listeners.has('cheshi:workspace-projects-changed'), false);
});
