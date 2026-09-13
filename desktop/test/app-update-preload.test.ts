import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import type { AppUpdateApi, AppUpdateResumeApi } from '../shared/app-update.ts';
import { APP_UPDATE_CHANNEL } from '../shared/app-update.ts';

for (const filename of ['preload.cjs', 'workspace-manager-preload.cjs']) {
  test(`${filename} exposes updates without leaking IPC events and removes listeners`, async () => {
    let api: (AppUpdateApi & AppUpdateResumeApi) | undefined;
    const calls: unknown[][] = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    vm.runInNewContext(readFileSync(new URL(`../runtime/${filename}`, import.meta.url), 'utf8'), {
      process: { platform: 'darwin', argv: ['--cheshi-manager-name=Workspaces', '--cheshi-manager-root='] },
      window: { addEventListener() {} }, document: { readyState: 'loading' },
      require(name: string) {
        assert.equal(name, 'electron');
        return {
          contextBridge: { exposeInMainWorld(key: string, value: AppUpdateApi & AppUpdateResumeApi & { api?: AppUpdateApi & AppUpdateResumeApi }) {
            api = key === 'workspaceManager' ? value.api : value;
          } },
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
    await api.getAppUpdate();
    await api.installAppUpdate();
    await api.openAppRelease();
    await api.getUpdateResume();
    await api.saveUpdateResume({ sections: { editor: 'unsaved' } });
    await api.acknowledgeAppUpdate('request', null);
    await api.clearUpdateResume();
    assert.deepEqual(calls.map(call => call[0]), ['get', 'install', 'open', 'resume', 'save', 'ack', 'clear']
      .map(suffix => `${APP_UPDATE_CHANNEL}:${suffix}`));
    assert.equal(calls[5]?.[1], 'request');
    assert.equal(calls[5]?.[2], null);
    const received: unknown[] = [];
    const subscriptions = [api.onAppUpdate(value => received.push(value)),
      api.onPrepareAppUpdate(value => received.push(value)), api.onAppUpdateCommitted(value => received.push(value)),
      api.onAppUpdatePreparationCancelled(() => received.push('cancelled'))];
    listeners.get(`${APP_UPDATE_CHANNEL}:changed`)?.({ secretEvent: true }, { phase: 'idle' });
    listeners.get(`${APP_UPDATE_CHANNEL}:prepare`)?.({}, 'prepare-id');
    listeners.get(`${APP_UPDATE_CHANNEL}:committed`)?.({}, 'commit-id');
    listeners.get(`${APP_UPDATE_CHANNEL}:cancelled`)?.({}, undefined);
    assert.deepEqual(received, [{ phase: 'idle' }, 'prepare-id', 'commit-id', 'cancelled']);
    subscriptions.forEach(unsubscribe => unsubscribe());
    assert.equal(listeners.size, 0);
  });
}
