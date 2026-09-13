import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { registerTemporaryChatIpc } from '../lib/temporary-chat-ipc.mts';
import { TemporaryChatClosedError } from '../shared/temporary-chat.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function expectFailure(operation: Promise<unknown>, message: string) {
  try { await operation; } catch (error) {
    expect(String(error)).toContain(message);
    return;
  }
  throw new Error('Expected operation to fail.');
}

function fixture(cancelPendingModels = false) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const instances: Array<{ sends: unknown[]; closes: number }> = [];
  const models = createDeferred<[]>();
  const files = createDeferred<string[]>();
  const cleanupErrors: unknown[] = [];
  let allowed = true;
  const registry = registerTemporaryChatIpc({
    ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
    assertSender() { if (!allowed) throw new Error('Unauthorized sender'); },
    selectFiles: () => files.promise,
    onCleanupError(error) { cleanupErrors.push(error); },
    createService() {
      const state = { sends: [] as unknown[], closes: 0 };
      instances.push(state);
      return {
        models: () => models.promise,
        async send(request: unknown) { state.sends.push(request); return { text: 'Reply', model: 'test' }; },
        async close() {
          state.closes++;
          if (cancelPendingModels) models.reject(new TemporaryChatClosedError());
        },
      };
    },
  });
  const owner = () => new EventEmitter();
  const invoke = async (sender: EventEmitter, name: string, ...args: unknown[]) => {
    const handler = handlers.get(`cheshi:temporary-chat-${name}`);
    if (!handler) throw new Error('Missing handler');
    // The injected IPC boundary only needs an owner with event subscription methods.
    return handler({ sender } as unknown as IpcMainInvokeEvent, ...args);
  };
  return { registry, instances, models, files, cleanupErrors, owner, invoke, deny() { allowed = false; } };
}

test('temporary chat stays scoped to its owner and close never reopens it', async () => {
  const setup = fixture();
  const first = setup.owner();
  const second = setup.owner();
  setup.models.resolve([]);
  await setup.invoke(first, 'models', 'one');
  await setup.invoke(second, 'models', 'two');
  await expectFailure(setup.invoke(second, 'send', 'one', {}), 'closed');
  await setup.invoke(first, 'send', 'one', { text: 'first' });
  await setup.invoke(first, 'send', 'one', { text: 'follow-up' });
  expect(setup.instances[0]?.sends).toHaveLength(2);
  await setup.invoke(first, 'close', 'one');
  await setup.invoke(first, 'close', 'one');
  await expectFailure(setup.invoke(first, 'send', 'one', {}), 'closed');
  expect(setup.instances[0]?.closes).toBe(1);
  expect(setup.instances[1]?.closes).toBe(0);
  await setup.registry.stop();
  expect(setup.instances[1]?.closes).toBe(1);
});

test('closing during model loading cannot resurrect the session', async () => {
  const setup = fixture(true);
  const owner = setup.owner();
  const loading = setup.invoke(owner, 'models', 'one');
  await setup.invoke(owner, 'close', 'one');
  expect(await loading).toEqual({ status: 'closed' });
  await expectFailure(setup.invoke(owner, 'send', 'one', {}), 'closed');
  expect(setup.instances).toHaveLength(1);
  expect(setup.instances[0]?.closes).toBe(1);
  await setup.registry.stop();
});

test('only cross-document main-frame navigation ends a session', async () => {
  const setup = fixture();
  const owner = setup.owner();
  setup.models.resolve([]);
  await setup.invoke(owner, 'models', 'one');
  owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  await setup.invoke(owner, 'send', 'one', {});
  owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await expectFailure(setup.invoke(owner, 'send', 'one', {}), 'closed');
  await setup.registry.stop();
  expect(setup.instances[0]?.closes).toBe(1);
  expect(owner.listenerCount('did-start-navigation')).toBe(0);
});

test('renderer crash and destruction close owned clients and remove listeners', async () => {
  const setup = fixture();
  const owner = setup.owner();
  setup.models.resolve([]);
  await setup.invoke(owner, 'models', 'one');
  owner.emit('render-process-gone');
  owner.emit('destroyed');
  await setup.registry.stop();
  expect(setup.instances[0]?.closes).toBe(1);
  expect(owner.eventNames()).toEqual([]);
  expect(setup.cleanupErrors).toEqual([]);
});

test('late attachment picker results are discarded after close', async () => {
  const setup = fixture();
  const owner = setup.owner();
  setup.models.resolve([]);
  await setup.invoke(owner, 'models', 'one');
  const selecting = setup.invoke(owner, 'attachments', 'one');
  await setup.invoke(owner, 'close', 'one');
  setup.files.resolve([]);
  expect(await selecting).toEqual({ status: 'closed' });
  await setup.registry.stop();
});

test('invalid ids and unauthorized senders cannot create clients', async () => {
  const setup = fixture();
  const owner = setup.owner();
  await expectFailure(setup.invoke(owner, 'models', '../bad'), 'Invalid');
  setup.deny();
  await expectFailure(setup.invoke(owner, 'models', 'one'), 'Unauthorized');
  expect(setup.instances).toHaveLength(0);
  await setup.registry.stop();
});

test('model connection failures still reject instead of being treated as cancellation', async () => {
  const setup = fixture();
  const loading = setup.invoke(setup.owner(), 'models', 'one');
  setup.models.reject(new Error('Connection initialization failed'));
  await expectFailure(loading, 'Connection initialization failed');
  await setup.registry.stop();
});

test('closing an old mount does not close the replacement session', async () => {
  const setup = fixture();
  const owner = setup.owner();
  setup.models.resolve([]);
  expect(await setup.invoke(owner, 'models', 'first')).toEqual({ status: 'ok', value: [] });
  await setup.invoke(owner, 'close', 'first');
  expect(await setup.invoke(owner, 'models', 'second')).toEqual({ status: 'ok', value: [] });
  await setup.invoke(owner, 'close', 'first');
  expect(await setup.invoke(owner, 'send', 'second', {})).toEqual({ status: 'ok', value: { text: 'Reply', model: 'test' } });
  expect(setup.instances[1]?.closes).toBe(0);
  await setup.registry.stop();
});
