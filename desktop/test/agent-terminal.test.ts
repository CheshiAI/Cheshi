import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain } from 'electron';
import { AgentTerminalManager } from '../lib/agent-management/terminal.mts';
import { registerAgentManagementIpc } from '../lib/agent-management/ipc.mts';
import { closeWorkspaceWindow } from '../lib/workspace-application.mts';
import type { AgentEngine } from '../lib/agent-management/engine.mts';
import { parseAgentTerminalBounds } from '../shared/agent-terminal.ts';

type Options = ConstructorParameters<typeof AgentTerminalManager>[0];
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(command: () => Promise<string> = async () => '/usr/bin/true') {
  const events = new EventEmitter(), owner = new EventEmitter();
  let destroyed = false;
  const messages: unknown[] = [], updates: unknown[] = [], closed: number[] = [];
  Object.assign(owner, { getZoomFactor: () => 1, isDestroyed: () => destroyed,
    send: (_channel: string, value: unknown) => messages.push(value) });
  const window = Object.assign(events, { isDestroyed: () => destroyed,
    close: () => { destroyed = true; events.emit('closed'); },
    isVisible: () => true, isMinimized: () => false, getContentBounds: () => ({ width: 800, height: 600 }) }) as unknown as BrowserWindow;
  Object.defineProperty(window, 'webContents', { get() {
    if (destroyed) throw new TypeError('Object has been destroyed');
    return owner;
  } });
  const hosts: Parameters<NonNullable<Options['createHost']>>[0][] = [];
  const engine: AgentEngine = { kind: 'test', engines: async () => [], list: async () => [],
    inspect: async () => { throw Error('unused'); }, control: async () => {}, logs: async () => '', terminalCommand: command };
  const manager = new AgentTerminalManager({ window, engines: [engine], workingDirectory: '/tmp', createHost: options => {
    const index = hosts.push(options) - 1;
    return { available: true, sync: state => updates.push(state), updatePane: (...args) => updates.push(args),
      setDark: () => {}, setWindowVisible: () => {}, close: () => { closed.push(index); } };
  } });
  return { manager, hosts, messages, updates, closed, owner, window };
}
async function rejected(promise: Promise<unknown>, message: string) {
  let error: unknown;
  try { await promise; } catch (value) { error = value; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

test('container terminals retain their native shell when hidden and close on shell exit or workspace disposal', async () => {
  const f = fixture();
  const session = await f.manager.open('test:one', 'worker');
  expect(f.hosts[0]?.command).toBe('/usr/bin/true');
  await f.manager.update({ id: session.id, x: 10, y: 50, width: 600, height: 400, visible: true, dark: true });
  await f.manager.update({ id: session.id, x: 0, y: 0, width: 0, height: 0, visible: false, dark: true });
  expect(f.closed.length).toBe(0);
  f.hosts[0]?.onClose?.(session.id);
  expect(f.messages).toEqual([{ ...session, ended: true, error: null }]);
  const count = f.updates.length;
  await f.manager.update({ id: session.id, x: 0, y: 0, width: 600, height: 400, visible: true, dark: true });
  expect(f.updates.length).toBe(count);
  await f.manager.open('test:one', 'second');
  f.manager.dispose();
  expect(f.closed).toContain(1);
  await rejected(f.manager.open('test:one', 'worker'), 'unavailable');
});

test('reload cancels an opening terminal before native creation and disposes existing sessions', async () => {
  const pending = createDeferred<string>();
  const f = fixture(() => pending.promise);
  const opening = f.manager.open('test:one', 'worker');
  f.owner.emit('did-start-navigation', {}, 'http://localhost', false, true);
  pending.resolve('/usr/bin/true');
  await rejected(opening, 'reloaded');
  expect(f.hosts.length).toBe(0);
  f.manager.dispose();
});

test('terminal geometry rejects invalid flags and prevents surfaces outside their window', async () => {
  const f = fixture();
  const session = await f.manager.open('test:one', 'worker');
  const bounds = { id: session.id, x: 0, y: 0, width: 600, height: 400, visible: true, dark: true };
  expect(() => parseAgentTerminalBounds({ ...bounds, visible: 'true' })).toThrow('flag');
  expect(() => parseAgentTerminalBounds({ ...bounds, width: Infinity })).toThrow('bounds');
  await f.manager.update({ ...bounds, x: 700 });
  expect(f.updates.at(-1)).toEqual([session.id, { x: 700, y: 0, width: 600, height: 400 }, false]);
  f.manager.dispose();
});

for (const hasTerminal of [false, true]) {
  test(`workspace close completes after window destruction with terminal ${hasTerminal ? 'open' : 'unused'}`, async () => {
    const f = fixture();
    const session = hasTerminal ? await f.manager.open('test:one', 'worker') : null;
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
    const registration = registerAgentManagementIpc({ window: f.window, terminal: f.manager,
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler); },
        removeHandler: channel => { handlers.delete(channel); } },
      service: { engines: async () => ({ engines: [], error: null }),
        snapshot: async engineId => ({ engineId, online: true, agents: [], error: null }),
        details: async () => { throw new Error('unused'); },
        control: async engineId => ({ engineId, online: true, agents: [], error: null }) },
    });
    let completed = false;
    await closeWorkspaceWindow(f.window, () => { completed = true; });
    expect(completed).toBe(true);
    expect(f.window.isDestroyed()).toBe(true);
    expect(handlers.size).toBe(0);
    expect(f.owner.listenerCount('did-start-navigation')).toBe(0);
    expect(f.window.eventNames()).toEqual([]);
    registration.dispose();
    f.manager.dispose();
    if (session) {
      f.hosts[0]?.onClose?.(session.id);
      f.hosts[0]?.onError?.(new Error('late native callback'));
      await f.manager.update({ id: session.id, x: 0, y: 0, width: 10, height: 10, visible: true, dark: true });
    }
    expect(f.messages).toEqual([]);
    expect(f.closed).toEqual(hasTerminal ? [0] : []);
  });
}

test('window disposal rejects a pending terminal without creating a native host', async () => {
  const pending = createDeferred<string>();
  const f = fixture(() => pending.promise);
  const opening = f.manager.open('test:one', 'worker');
  f.window.close();
  f.manager.dispose();
  pending.resolve('/usr/bin/true');
  await rejected(opening, 'closed');
  expect(f.hosts).toEqual([]);
});
