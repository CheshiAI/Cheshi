import { expect, test } from 'bun:test';

import { createPluginDetailCache } from '../frontend/src/features/plugins/pluginDetailCache';
import type { CodexPluginDetail } from '../frontend/src/cheshiDesktop';

function plugin(name: string): CodexPluginDetail {
  return {
    id: `${name}@remote`, name, displayName: name, shortDescription: '', longDescription: '',
    developerName: 'Developer', category: 'Tools', capabilities: [], keywords: [], defaultPrompts: [],
    brandColor: null, hasLogo: false, installed: false, enabled: true, installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE', availability: 'AVAILABLE', disabledReason: null, source: 'remote',
    version: '1.0.0', localVersion: null, marketplaceName: 'remote', marketplaceDisplayName: 'Remote',
    reference: { pluginName: name, remoteMarketplaceName: 'remote' }, description: name,
    shareUrl: null, skills: [], apps: [], appTemplates: [], mcpServers: [], hooks: [], scheduledTasks: [],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('reopening a plugin or returning after another plugin reuses its detail', async () => {
  let calls = 0;
  const teams = plugin('teams');
  const calendar = plugin('calendar');
  const cache = createPluginDetailCache(async (value) => {
    calls += 1;
    return value.id === teams.id ? teams : calendar;
  });
  await cache.load(teams);
  await cache.load(calendar);
  expect(cache.peek(teams)).toBe(teams);
  expect(await cache.load({ ...teams })).toBe(teams);
  expect(cache.peek(calendar)).toBe(calendar);
  expect(calls).toBe(2);
});

test('reopening while a detail is loading shares the pending request', async () => {
  const teams = plugin('teams');
  const request = createDeferred<CodexPluginDetail>();
  const cache = createPluginDetailCache(() => request.promise);
  const operation = cache.load(teams);
  expect(cache.load(teams)).toBe(operation);
  request.resolve(teams);
  expect(await operation).toBe(teams);
});

test('cache invalidation prevents an earlier request from restoring stale details', async () => {
  const teams = plugin('teams');
  const request = createDeferred<CodexPluginDetail>();
  const updated = { ...teams, description: 'Updated' };
  let calls = 0;
  const cache = createPluginDetailCache(async () => ++calls === 1 ? request.promise : updated);
  const previous = cache.load(teams);
  await Promise.resolve();
  cache.clear();
  expect(cache.peek(teams)).toBeNull();
  expect(await cache.load(teams)).toBe(updated);
  request.resolve(teams);
  await previous;
  expect(cache.peek(teams)).toBe(updated);
});

test('version, installation and marketplace changes do not reuse an older detail', async () => {
  const teams = plugin('teams');
  const cache = createPluginDetailCache(async () => teams);
  await cache.load(teams);
  expect(cache.peek({ ...teams, version: '2.0.0' })).toBeNull();
  expect(cache.peek({ ...teams, installed: true })).toBeNull();
  expect(cache.peek({ ...teams, reference: { pluginName: 'teams', marketplacePath: '/local' } })).toBeNull();
});

test('a failed detail request is retried on the next open', async () => {
  const teams = plugin('teams');
  let calls = 0;
  const cache = createPluginDetailCache(async () => {
    if (++calls === 1) throw new Error('Unavailable');
    return teams;
  });
  let error: unknown;
  try {
    await cache.load(teams);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(cache.peek(teams)).toBeNull();
  expect(await cache.load(teams)).toBe(teams);
});
