import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AutoUpdater } from 'electron';
import { appUpdateUnavailableReason, stageAppUpdate } from '../lib/app-update-installer.mts';
import type { AppRelease } from '../shared/app-update';

const release: AppRelease = { version: '0.0.2-alpha', tag: 'v0.0.2-alpha', notes: 'Changes',
  url: 'https://github.com/CheshiAI/Cheshi/releases/tag/v0.0.2-alpha',
  asset: { name: 'app.zip', url: 'https://github.com/CheshiAI/Cheshi/releases/download/v0.0.2-alpha/app.zip',
    size: 1, sha256: 'a'.repeat(64) } };
async function expectFailure(operation: Promise<unknown>, message: string) {
  let rejection: unknown;
  try { await operation; } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}
function fixture(outcome: 'downloaded' | 'unavailable' | 'error' | 'throw' | 'timeout' = 'downloaded') {
  const events = new EventEmitter();
  const feedUrls: unknown[] = [];
  const cleanup: string[] = [];
  const updater = {
    on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    setFeedURL(options: unknown) { feedUrls.push(options); },
    checkForUpdates() {
      if (outcome === 'throw') throw new Error('Squirrel unavailable');
      if (outcome === 'timeout') return;
      queueMicrotask(() => events.emit(outcome === 'downloaded' ? 'update-downloaded'
        : outcome === 'unavailable' ? 'update-not-available' : 'error', new Error('Squirrel failed')));
    },
  };
  const options = {
    download: async () => ({ filename: '/verified/app.zip', dispose: async () => { cleanup.push('download'); } }),
    serve: async () => ({ url: 'http://localhost:1234/token/feed', dispose: async () => { cleanup.push('feed'); } }),
    timeoutMs: 5,
  };
  return { updater: updater as Pick<AutoUpdater, 'on' | 'removeListener' | 'setFeedURL' | 'checkForUpdates'>,
    events, cleanup, feedUrls, options };
}

describe('update installation staging', () => {
  test('stages verified feed and removes listeners and temporary assets after success', async () => {
    const f = fixture();
    await stageAppUpdate(f.updater, release, f.options);
    expect(f.feedUrls).toEqual([{ url: 'http://localhost:1234/token/feed', serverType: 'default' }]);
    expect(f.cleanup).toEqual(['feed', 'download']);
    expect(f.events.eventNames()).toEqual([]);
  });
  test('cleans all temporary assets on Squirrel errors, unavailable results, throws and timeout', async () => {
    for (const outcome of ['unavailable', 'error', 'throw', 'timeout'] as const) {
      const f = fixture(outcome);
      await expectFailure(stageAppUpdate(f.updater, release, f.options), outcome === 'timeout' ? 'timed out'
        : outcome === 'unavailable' ? 'unavailable' : 'Squirrel');
      expect(f.cleanup).toEqual(['feed', 'download']);
      expect(f.events.eventNames()).toEqual([]);
    }
  });
  test('removes downloaded bytes even when feed creation or feed disposal fails', async () => {
    const startup = fixture();
    await expectFailure(stageAppUpdate(startup.updater, release, { ...startup.options,
      serve: async () => { throw new Error('feed startup'); } }), 'feed startup');
    expect(startup.cleanup).toEqual(['download']);
    const shutdown = fixture();
    await expectFailure(stageAppUpdate(shutdown.updater, release, { ...shutdown.options,
      serve: async () => ({ url: 'http://localhost/feed', dispose: async () => { throw new Error('feed close'); } }) }), 'feed close');
    expect(shutdown.cleanup).toEqual(['download']);
  });
  test('rejects missing assets before downloading', async () => {
    const f = fixture();
    await expectFailure(stageAppUpdate(f.updater, { ...release, asset: null }, f.options), 'No update asset');
    expect(f.feedUrls).toEqual([]);
  });
  test('explains unsupported installations without starting native tools', async () => {
    expect(await appUpdateUnavailableReason({ packaged: false, platform: 'darwin', executable: '/dev/app' })).toContain('packaged app');
    expect(await appUpdateUnavailableReason({ packaged: true, platform: 'linux', executable: '/app' })).toContain('platform');
    expect(await appUpdateUnavailableReason({ packaged: true, platform: 'darwin',
      executable: '/Volumes/Cheshi/Cheshi.app/Contents/MacOS/Cheshi' })).toContain('Applications');
  });
});
