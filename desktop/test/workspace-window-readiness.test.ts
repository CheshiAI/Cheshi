import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createWorkspaceWindowReadiness } from '../lib/workspace-window-readiness.mts';

for (const order of [
  ['browser', 'renderer', 'load'], ['renderer', 'load', 'browser'], ['load', 'browser', 'renderer'],
] as const) {
  test(`waits for all startup signals in order ${order.join(', ')}`, async () => {
    const gate = createWorkspaceWindowReadiness({ signal: new AbortController().signal });
    let resolved = false;
    void gate.ready.then(() => { resolved = true; });
    const signal = {
      browser: () => gate.browserReady(), renderer: () => gate.rendererReady('light'), load: () => gate.loaded(),
    };
    for (const stage of order.slice(0, -1)) {
      signal[stage]();
      await Promise.resolve();
      assert.equal(resolved, false);
      assert.throws(() => gate.assertReady(), /not ready/);
    }
    signal[order[2]]();
    assert.equal(await gate.ready, 'light');
    assert.equal(gate.assertReady(), 'light');
  });
}

test('load and renderer failures reject startup without permitting reveal', async () => {
  const gate = createWorkspaceWindowReadiness({ signal: new AbortController().signal });
  const failure = new Error('load failed');
  gate.browserReady();
  gate.fail(failure);
  gate.rendererReady('dark');
  gate.loaded();
  await assert.rejects(gate.ready, failure);
  assert.throws(() => gate.assertReady(), failure);
});

test('disposal aborts a startup waiting for renderer content', async () => {
  const abort = new AbortController();
  const gate = createWorkspaceWindowReadiness({ signal: abort.signal });
  gate.browserReady();
  gate.loaded();
  abort.abort();
  await assert.rejects(gate.ready, /canceled/);
});

test('a startup disposed before readiness registration rejects immediately', async () => {
  const abort = new AbortController();
  abort.abort();
  const gate = createWorkspaceWindowReadiness({ signal: abort.signal });
  await assert.rejects(gate.ready, /canceled/);
});

test('timeout rejects incomplete content instead of revealing a blank window', async () => {
  const gate = createWorkspaceWindowReadiness({ signal: new AbortController().signal, timeoutMs: 5 });
  gate.browserReady();
  gate.loaded();
  await Promise.all([assert.rejects(gate.ready, /did not become ready/), delay(10)]);
  assert.throws(() => gate.assertReady(), /did not become ready/);
});

test('a renderer lost after hidden preparation cannot subsequently be revealed', async () => {
  const gate = createWorkspaceWindowReadiness({ signal: new AbortController().signal });
  gate.browserReady();
  gate.rendererReady('dark');
  gate.loaded();
  await gate.ready;
  gate.fail(new Error('renderer exited'));
  assert.throws(() => gate.assertReady(), /renderer exited/);
});
