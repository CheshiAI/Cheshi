import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { WorkspaceIpcRouter } from '../lib/workspace-ipc-router.mts';

type Handler = Parameters<IpcMain['handle']>[1];
type Listener = Parameters<IpcMain['on']>[1];

function owner() {
  const events = new EventEmitter();
  let destroyed = false;
  const contents = {
    id: 1, mainFrame: {}, isDestroyed: () => destroyed,
    once: events.once.bind(events), off: events.off.bind(events),
  } as unknown as WebContents;
  return {
    contents, events,
    destroy() { destroyed = true; events.emit('destroyed'); },
  };
}

function event(sender: WebContents, senderFrame = sender.mainFrame): IpcMainEvent {
  return { sender, senderFrame, returnValue: undefined } as unknown as IpcMainEvent;
}

function harness() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Listener>();
  const registrations: string[] = [];
  const emitter = {
    handle(channel: string, handler: Handler) {
      assert.equal(handlers.has(channel), false, 'native invoke route must be registered once');
      handlers.set(channel, handler); registrations.push(`handle:${channel}`);
    },
    removeHandler(channel: string) { handlers.delete(channel); },
    on(channel: string, listener: Listener) {
      assert.equal(listeners.has(channel), false, 'native event route must be registered once');
      listeners.set(channel, listener); registrations.push(`on:${channel}`);
      return emitter as IpcMain;
    },
    off(channel: string, listener: Listener) {
      assert.equal(listeners.get(channel), listener);
      listeners.delete(channel);
      return emitter as IpcMain;
    },
  };
  const router = new WorkspaceIpcRouter(emitter);
  return {
    router, handlers, listeners, registrations,
    invoke(channel: string, request: IpcMainEvent, ...args: unknown[]) {
      const handler = handlers.get(channel);
      assert.ok(handler, 'native invoke route exists');
      return handler(request as IpcMainInvokeEvent, ...args);
    },
    send(channel: string, request: IpcMainEvent, ...args: unknown[]) {
      const listener = listeners.get(channel);
      assert.ok(listener, 'native event route exists');
      listener(request, ...args);
      return request.returnValue;
    },
  };
}

test('overlapping invoke channels isolate two workspace roots using sender identity, not numeric ids', async () => {
  const h = harness();
  const first = h.router.createScope();
  const second = h.router.createScope();
  const a = owner();
  const b = owner();
  first.addOwner(a.contents); second.addOwner(b.contents);
  first.ipc.handle('cheshi:files', async (_event, path: string) => `/first/${path}`);
  second.ipc.handle('cheshi:files', (_event, path: string) => `/second/${path}`);
  assert.equal(await h.invoke('cheshi:files', event(a.contents), 'readme'), '/first/readme');
  assert.equal(await h.invoke('cheshi:files', event(b.contents), 'readme'), '/second/readme');
  assert.deepEqual(h.registrations, ['handle:cheshi:files']);
  assert.throws(() => first.ipc.handle('cheshi:files', () => 'overwrite'), /already registered/u);
  first.ipc.removeHandler('cheshi:files');
  assert.throws(() => h.invoke('cheshi:files', event(a.contents)), /not authorized/u);
  assert.equal(await h.invoke('cheshi:files', event(b.contents), 'readme'), '/second/readme');
});

test('manager owners may use management channels only, without inheriting workspace services', () => {
  const h = harness();
  const scope = h.router.createScope();
  const main = owner();
  const manager = owner();
  scope.addOwner(main.contents); scope.addOwner(manager.contents, true);
  scope.ipc.handle('cheshi:workspace-management:list', () => ['/first']);
  scope.ipc.handle('cheshi:workspace-management-unsafe', () => 'private');
  scope.ipc.handle('cheshi:files', () => 'private');
  scope.ipc.on('cheshi:get-workspace-metadata', (request) => { request.returnValue = '/first'; });
  assert.deepEqual(h.invoke('cheshi:workspace-management:list', event(manager.contents)), ['/first']);
  for (const channel of ['cheshi:files', 'cheshi:workspace-management-unsafe']) {
    assert.throws(() => h.invoke(channel, event(manager.contents)), /not authorized/u);
    assert.equal(h.invoke(channel, event(main.contents)), 'private');
  }
  assert.equal(h.send('cheshi:get-workspace-metadata', event(manager.contents)), null);
  assert.equal(h.send('cheshi:get-workspace-metadata', event(main.contents)), '/first');
  assert.throws(() => scope.addOwner(manager.contents), /different capabilities/u);
});

test('management capability normalization preserves literal true and duplicate registration semantics', () => {
  const h = harness();
  const scope = h.router.createScope();
  scope.ipc.handle('cheshi:files', () => 'workspace');
  for (const value of [false, undefined, null, 0, 1, '', 'true', {}, true]) {
    const sender = owner();
    scope.addOwner(sender.contents, value as boolean);
    const restricted = value === true;
    scope.addOwner(sender.contents, restricted);
    assert.equal(sender.events.listenerCount('destroyed'), 1);
    assert.throws(() => scope.addOwner(sender.contents, !restricted), /different capabilities/u);
    if (restricted) assert.throws(() => h.invoke('cheshi:files', event(sender.contents)), /not authorized/u);
    else assert.equal(h.invoke('cheshi:files', event(sender.contents)), 'workspace');
  }
  scope.dispose();
});

test('unknown senders, subframes and missing frames cannot invoke or receive synchronous metadata', () => {
  const h = harness();
  const scope = h.router.createScope();
  const registered = owner();
  const unknown = owner();
  scope.addOwner(registered.contents);
  let calls = 0;
  scope.ipc.handle('cheshi:read', () => { calls += 1; return 'private'; });
  scope.ipc.on('cheshi:metadata', (request) => { calls += 1; request.returnValue = 'private'; });
  const invalid = [event(unknown.contents), event(registered.contents, unknown.contents.mainFrame),
    { ...event(registered.contents), senderFrame: null } as IpcMainEvent];
  for (const request of invalid) {
    assert.throws(() => h.invoke('cheshi:read', request), /not authorized/u);
    assert.equal(h.send('cheshi:metadata', request), null);
  }
  assert.equal(calls, 0);
});

test('synchronous metadata and multiple listeners route only to the owning scope', () => {
  const h = harness();
  const first = h.router.createScope();
  const second = h.router.createScope();
  const a = owner(); const b = owner();
  first.addOwner(a.contents); second.addOwner(b.contents);
  const calls: string[] = [];
  first.ipc.on('cheshi:metadata', (request) => { request.returnValue = '/first'; });
  first.ipc.on('cheshi:metadata', (_request, value: string) => { calls.push(`first:${value}`); });
  second.ipc.on('cheshi:metadata', (request, value: string) => {
    request.returnValue = '/second'; calls.push(`second:${value}`);
  });
  assert.equal(h.send('cheshi:metadata', event(a.contents), 'a'), '/first');
  assert.equal(h.send('cheshi:metadata', event(b.contents), 'b'), '/second');
  assert.deepEqual(calls, ['first:a', 'second:b']);
  assert.deepEqual(h.registrations, ['on:cheshi:metadata']);
});

test('off removes the original listener once and releases only the final scoped event route', () => {
  const h = harness();
  const first = h.router.createScope(); const second = h.router.createScope();
  const a = owner(); first.addOwner(a.contents);
  let calls = 0;
  const listener: Listener = () => { calls += 1; };
  assert.equal(first.ipc.on('cheshi:ready', listener), first.ipc);
  first.ipc.on('cheshi:ready', listener);
  second.ipc.on('cheshi:ready', listener);
  assert.equal(first.ipc.off('cheshi:ready', listener), first.ipc);
  h.send('cheshi:ready', event(a.contents));
  assert.equal(calls, 1);
  first.ipc.off('cheshi:ready', listener);
  assert.equal(h.send('cheshi:ready', event(a.contents)), null);
  assert.equal(h.listeners.size, 1);
  second.ipc.off('cheshi:ready', listener);
  assert.equal(h.listeners.size, 0);
});

test('disposing a scope rejects its owner while keeping surviving routes and releases all native routes last', () => {
  const h = harness();
  const first = h.router.createScope(); const second = h.router.createScope();
  const a = owner(); const b = owner();
  first.addOwner(a.contents); second.addOwner(b.contents);
  first.ipc.handle('cheshi:read', () => '/first'); second.ipc.handle('cheshi:read', () => '/second');
  first.ipc.on('cheshi:metadata', (request) => { request.returnValue = '/first'; });
  second.ipc.on('cheshi:metadata', (request) => { request.returnValue = '/second'; });
  first.dispose(); first.dispose();
  assert.equal(a.events.listenerCount('destroyed'), 0);
  assert.throws(() => h.invoke('cheshi:read', event(a.contents)), /not authorized/u);
  assert.equal(h.send('cheshi:metadata', event(a.contents)), null);
  assert.equal(h.invoke('cheshi:read', event(b.contents)), '/second');
  assert.equal(h.send('cheshi:metadata', event(b.contents)), '/second');
  assert.throws(() => first.addOwner(a.contents), /disposed/u);
  assert.throws(() => first.ipc.handle('cheshi:new', () => null), /disposed/u);
  assert.throws(() => first.ipc.on('cheshi:new', () => {}), /disposed/u);
  second.dispose();
  assert.equal(b.events.listenerCount('destroyed'), 0);
  assert.equal(h.handlers.size, 0); assert.equal(h.listeners.size, 0);
});

test('owner destruction revokes access and duplicate registration cannot reassign another scope', () => {
  const h = harness();
  const first = h.router.createScope(); const second = h.router.createScope();
  const a = owner();
  first.addOwner(a.contents); first.addOwner(a.contents);
  assert.equal(a.events.listenerCount('destroyed'), 1);
  assert.throws(() => second.addOwner(a.contents), /different capabilities/u);
  first.ipc.handle('cheshi:read', () => 'private');
  a.destroy();
  assert.equal(a.events.listenerCount('destroyed'), 0);
  assert.throws(() => h.invoke('cheshi:read', event(a.contents)), /not authorized/u);
  assert.throws(() => second.addOwner(a.contents), /destroyed/u);
});
