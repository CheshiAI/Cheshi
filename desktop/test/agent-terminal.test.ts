import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { AgentTerminalManager } from '../lib/agent-management/terminal.mts';
import type { AgentEngine } from '../lib/agent-management/engine.mts';
import { parseAgentTerminalBounds } from '../shared/agent-terminal.ts';

type Options = ConstructorParameters<typeof AgentTerminalManager>[0];
function fixture(command: () => Promise<string> = async () => '/usr/bin/true') {
  const events = new EventEmitter(), owner = new EventEmitter();
  const messages: unknown[] = [], updates: unknown[] = [], closed: number[] = [];
  Object.assign(owner, { getZoomFactor: () => 1, isDestroyed: () => false,
    send: (_channel: string, value: unknown) => messages.push(value) });
  const window = Object.assign(events, { webContents: owner, isDestroyed: () => false,
    isVisible: () => true, isMinimized: () => false, getContentBounds: () => ({ width: 800, height: 600 }) }) as unknown as BrowserWindow;
  const hosts: Parameters<NonNullable<Options['createHost']>>[0][] = [];
  const engine: AgentEngine = { kind: 'test', engines: async () => [], list: async () => [],
    inspect: async () => { throw Error('unused'); }, control: async () => {}, logs: async () => '', terminalCommand: command };
  const manager = new AgentTerminalManager({ window, engines: [engine], workingDirectory: '/tmp', createHost: options => {
    const index = hosts.push(options) - 1;
    return { available: true, sync: state => updates.push(state), updatePane: (...args) => updates.push(args),
      setDark: () => {}, setWindowVisible: () => {}, close: () => { closed.push(index); } };
  } });
  return { manager, hosts, messages, updates, closed, owner };
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
  let resolve!: (value: string) => void;
  const pending = new Promise<string>(yes => { resolve = yes; });
  const f = fixture(() => pending);
  const opening = f.manager.open('test:one', 'worker');
  f.owner.emit('did-start-navigation', {}, 'http://localhost', false, true);
  resolve('/usr/bin/true');
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
