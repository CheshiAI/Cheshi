import assert from 'node:assert/strict';
import test from 'node:test';

import { GhosttySurfaceHost } from '../lib/ghostty-surface-host.mts';

type HostOptions = ConstructorParameters<typeof GhosttySurfaceHost>[0];
type GhosttyBinding = NonNullable<HostOptions['binding']>;
type GhosttyEventHandler = Parameters<GhosttyBinding['setEventHandler']>[0];
type BindingCall = [method: string, ...arguments_: unknown[]];
type TestBinding = GhosttyBinding & {
  calls: BindingCall[];
  emitEvent(event: unknown): void;
};

function invalidBoolean(value: unknown): boolean {
  return value as boolean;
}

function createBinding(): TestBinding {
  const calls: BindingCall[] = [];
  let nextSurfaceId = 1;
  let eventHandler: GhosttyEventHandler | null = null;
  return {
    calls,
    initialize(fontDirectory: string) {
      calls.push(['initialize', fontDirectory]);
      return true;
    },
    setEventHandler(handler: GhosttyEventHandler) {
      eventHandler = handler;
    },
    emitEvent(event: unknown) {
      const handler = eventHandler;
      if (!handler) throw new Error('Expected the Ghostty event handler to be installed.');
      handler(event);
    },
    setDark(dark: boolean) {
      calls.push(['setDark', dark]);
    },
    createSurface(
      handle: Buffer,
      frame: Parameters<GhosttyBinding['createSurface']>[1],
      workingDirectory: string,
      dark: boolean,
    ) {
      calls.push(['createSurface', handle, frame, workingDirectory, dark]);
      return nextSurfaceId++;
    },
    resizeSurface(surfaceId: number, frame: Parameters<GhosttyBinding['resizeSurface']>[1]) {
      calls.push(['resizeSurface', surfaceId, frame]);
      return true;
    },
    destroySurface(surfaceId: number) {
      calls.push(['destroySurface', surfaceId]);
      return true;
    },
    setFocus(surfaceId: number, focused: boolean) {
      calls.push(['setFocus', surfaceId, focused]);
      return true;
    },
    setOccluded(surfaceId: number, occluded: boolean) {
      calls.push(['setOccluded', surfaceId, occluded]);
      return true;
    },
  };
}

function createHost(binding: TestBinding, callbacks: Partial<HostOptions> = {}): GhosttySurfaceHost {
  return new GhosttySurfaceHost({
    owner: { getNativeWindowHandle: () => Buffer.alloc(8) },
    workingDirectory: '/workspace',
    binding,
    ...callbacks,
  });
}

test('keeps inactive native panes occluded during synchronization', () => {
  const binding = createBinding();
  const host = createHost(binding);
  const frame = { x: 10, y: 20, width: 300, height: 200 };

  host.sync({
    paneIds: ['first', 'second'],
    visiblePaneIds: ['first'],
    activePaneId: 'first',
    pageVisible: true,
  });
  host.updatePane('first', frame, true);
  host.updatePane('second', frame, true);

  assert.equal(host.surfaces.has('first'), true);
  assert.equal(host.surfaces.has('second'), false);
  assert.deepEqual(binding.calls.findLast((call) => call[0] === 'setOccluded'), ['setOccluded', 1, false]);

  host.sync({ paneIds: [], visiblePaneIds: [], activePaneId: null, pageVisible: false });
  assert.deepEqual(binding.calls.findLast((call) => call[0] === 'destroySurface'), ['destroySurface', 1]);
});

test('occludes a surface when its host no longer has valid bounds', () => {
  const binding = createBinding();
  const host = createHost(binding);
  host.sync({
    paneIds: ['first'],
    visiblePaneIds: ['first'],
    activePaneId: 'first',
    pageVisible: true,
  });
  host.updatePane('first', { x: 10, y: 20, width: 300, height: 200 }, true);
  host.updatePane('first', { x: 10, y: 20, width: 0, height: 0 }, false);

  assert.deepEqual(binding.calls.findLast((call) => call[0] === 'setOccluded'), ['setOccluded', 1, true]);
  assert.deepEqual(binding.calls.findLast((call) => call[0] === 'setFocus'), ['setFocus', 1, false]);
});

test('does not repeat unchanged native frame, visibility, or focus calls', () => {
  const binding = createBinding();
  const host = createHost(binding);
  const frame = { x: 10, y: 20, width: 300, height: 200 };
  const syncState = {
    paneIds: ['first'],
    visiblePaneIds: ['first'],
    activePaneId: 'first',
    pageVisible: true,
  };

  host.sync(syncState);
  host.updatePane('first', frame, true);
  const callCount = binding.calls.length;

  host.sync(syncState);
  host.updatePane('first', frame, true);
  assert.equal(binding.calls.length, callCount);

  host.updatePane('first', { ...frame, width: 320 }, true);
  assert.deepEqual(binding.calls.slice(callCount), [
    ['resizeSurface', 1, { ...frame, width: 320 }],
  ]);
});

test('requires literal true for native theme and visibility boundaries', () => {
  const binding = createBinding();
  const host = createHost(binding, { dark: invalidBoolean(1) });
  const frame = { x: 10, y: 20, width: 300, height: 200 };

  assert.equal(host.dark, false);
  host.sync({
    paneIds: ['first'],
    visiblePaneIds: ['first'],
    activePaneId: 'first',
    pageVisible: invalidBoolean(1),
  });
  host.updatePane('first', frame, invalidBoolean(1));
  assert.equal(host.surfaces.size, 0);

  host.sync({
    paneIds: ['first'],
    visiblePaneIds: ['first'],
    activePaneId: 'first',
    pageVisible: true,
  });
  host.updatePane('first', frame, true);
  assert.equal(host.surfaces.size, 1);

  host.setWindowVisible(invalidBoolean(1));
  assert.deepEqual(binding.calls.findLast((call) => call[0] === 'setOccluded'), ['setOccluded', 1, true]);
});

test('forwards native surface events to the matching pane', async () => {
  const binding = createBinding();
  const focusedPaneIds: string[] = [];
  const splitRequests: Array<[string, string]> = [];
  const host = createHost(binding, {
    onFocus: (paneId) => focusedPaneIds.push(paneId),
    onSplit: (paneId, direction) => splitRequests.push([paneId, direction]),
  });

  host.sync({
    paneIds: ['first'],
    visiblePaneIds: ['first'],
    activePaneId: 'first',
    pageVisible: true,
  });
  host.updatePane('first', { x: 10, y: 20, width: 300, height: 200 }, true);
  binding.emitEvent({ surfaceId: 1, type: 'focus' });
  binding.emitEvent({ surfaceId: 1, type: 'split-request', value: 'down' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(focusedPaneIds, ['first']);
  assert.deepEqual(splitRequests, [['first', 'down']]);
});

test('routes shared native events to each window and keeps remaining hosts alive after close', async () => {
  const binding = createBinding();
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];
  const first = createHost(binding, { onTitle: (_paneId, title) => firstEvents.push(title) });
  const second = createHost(binding, { onTitle: (_paneId, title) => secondEvents.push(title) });
  const showPane = (host: GhosttySurfaceHost) => {
    host.sync({ paneIds: ['same-pane'], visiblePaneIds: ['same-pane'], activePaneId: 'same-pane', pageVisible: true });
    host.updatePane('same-pane', { x: 0, y: 0, width: 300, height: 200 }, true);
    return host.surfaces.get('same-pane');
  };
  const firstId = showPane(first);
  const secondId = showPane(second);
  binding.emitEvent({ surfaceId: firstId, type: 'set-title', value: 'first window' });
  binding.emitEvent({ surfaceId: secondId, type: 'set-title', value: 'second window' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(firstEvents, ['first window']);
  assert.deepEqual(secondEvents, ['second window']);

  binding.emitEvent({ surfaceId: firstId, type: 'set-title', value: 'queued before close' });
  first.close();
  first.close();
  binding.emitEvent({ surfaceId: firstId, type: 'set-title', value: 'closed window' });
  binding.emitEvent({ surfaceId: secondId, type: 'set-title', value: 'still open' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(firstEvents, ['first window']);
  assert.deepEqual(secondEvents, ['second window', 'still open']);
  assert.equal(second.surfaces.get('same-pane'), secondId);
  second.close();

  const reopenedEvents: string[] = [];
  const reopened = createHost(binding, { onTitle: (_paneId, title) => reopenedEvents.push(title) });
  binding.emitEvent({ surfaceId: showPane(reopened), type: 'set-title', value: 'reopened' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reopenedEvents, ['reopened']);
  reopened.close();
});
