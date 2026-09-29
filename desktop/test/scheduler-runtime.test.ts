import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native strip-only Node persists scheduler SQLite definitions and history across reopening', () => {
  const storeUrl = new URL('../lib/scheduler/store.mts', import.meta.url).href;
  const engineUrl = new URL('../lib/scheduler/engine.mts', import.meta.url).href;
  const runnerUrl = new URL('../lib/scheduler/codex-runner.mts', import.meta.url).href;
  const optionsUrl = new URL('../lib/workspace-chat-service-options.mts', import.meta.url).href;
  const source = `
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    const { openSchedulerStore } = await import(${JSON.stringify(storeUrl)});
    const { SchedulerEngine } = await import(${JSON.stringify(engineUrl)});
    await import(${JSON.stringify(runnerUrl)});
    await import(${JSON.stringify(optionsUrl)});
    await import('./desktop/lib/scheduler/application.mts');
    await import('./desktop/lib/scheduler/background.mts');
    await import('./desktop/lib/scheduler/notifications.mts');
    await import('./desktop/lib/scheduler/migration.mts');
    await import('./desktop/lib/scheduler/workspace.mts');
    const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-scheduler-node-'));
    let store;
    try {
      const filename = path.join(directory, 'scheduler.sqlite');
      store = await openSchedulerStore(filename);
      const now = Date.now();
      const engine = new SchedulerEngine(store, () => now);
      engine.setAuto(true);
      store.notificationPosition = 'top-right';
      engine.save('/workspace', { title:'Test', prompt:'Inspect', startAt:new Date(now+300000).toISOString(),
        timeZone:'Asia/Seoul', repeat:'once', enabled:true, threadId:null, permissionMode:'read-only', model:null, effort:'medium' });
      assert.equal(store.runs().length, 1);
      store.close(); store = await openSchedulerStore(filename);
      assert.equal(store.notificationPosition, 'top-right');
      assert.equal(store.auto, true); assert.equal(store.schedules().length, 1); assert.equal(store.runs().length, 1);
      console.log('Scheduler native persistence passed');
    } finally { store?.close(); rmSync(directory, { recursive:true, force:true }); }
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('Scheduler native persistence passed');
});
