import { expect, test } from 'bun:test';
import { createCodexUpdateProgress } from '../lib/agent-management/codex-update-progress.mts';
import { registryDeferred } from './agent-registry-fixtures';

test('Docker output reports activity only to its update scope without forwarding private output', async () => {
  const entered = registryDeferred<void>(), release = registryDeferred<void>();
  const received: (string | undefined)[] = [];
  const other: (string | undefined)[] = [];
  const progress = createCodexUpdateProgress(async (args, _input, output) => {
    if (args[0] === 'build') {
      entered.resolve(); await release.promise;
    }
    output?.();
    return 'private command output';
  });
  const updating = progress.track(stage => received.push(stage), async () => {
    progress.stage('dependencies');
    await progress.run(['build']);
    progress.stage('verifying-worker');
  });
  await entered.promise;
  await progress.run(['unrelated']);
  expect(received).toEqual(['dependencies']);
  await progress.track(stage => other.push(stage), () => progress.run(['other-update']));
  expect(other).toEqual([undefined, undefined]);
  release.resolve(); await updating;
  expect(received).toEqual(['dependencies', undefined, undefined, 'verifying-worker']);
});
