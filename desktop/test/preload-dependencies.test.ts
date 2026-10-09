import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { preloadDependencies, preloadRefreshQueue } from '../../scripts/preload-dependencies.mts';
import { createDeferred } from '../../experiments/codex-specialists/src/protocol.ts';

test('preload graph covers worker contracts through nested bridge imports for every entrypoint', () => {
  const root = resolve(import.meta.dir, '../..'), paths = preloadDependencies(root);
  for (const path of ['desktop/preload.cts', 'desktop/lib/agent-management-preload.cts',
    'desktop/shared/agent-management.ts', 'desktop/shared/agent-task-inspection.ts',
    'experiments/codex-specialists/src/work-contract.ts',
    'desktop/workspace-manager-preload.cts', 'desktop/sticky-notes-preload.cts']) {
    expect(paths).toContain(resolve(root, path));
  }
  expect(new Set(paths).size).toBe(paths.length);
});
test('restart waits for the new bundle and subsequent dependency changes remain ordered after a failed build', async () => {
  const gate = createDeferred<void>(), events: string[] = [];
  let count = 0;
  const refresh = preloadRefreshQueue(async () => {
    const round = ++count; events.push(`build:${round}`);
    if (round === 1) await gate.promise;
    if (round === 2) throw Error('Invalid source');
    events.push(`ready:${round}`);
  }, path => events.push(`restart:${path}`), () => { events.push('failed'); });
  const first = refresh('agent-management.ts'), second = refresh('broken.ts'), third = refresh('repaired.ts');
  await Promise.resolve(); expect(events).toEqual(['build:1']);
  gate.resolve(); await Promise.all([first, second, third]);
  expect(events).toEqual(['build:1', 'ready:1', 'build:2', 'failed', 'build:3', 'ready:3', 'restart:repaired.ts']);
});
