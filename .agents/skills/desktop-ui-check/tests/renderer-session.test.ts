import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { runRendererSession, type SessionResult } from '../scripts/renderer-session.mts';

function fixture(alreadyAttached = false) {
  const renderer = vm.createContext({ value: 'original' });
  let attached = alreadyAttached;
  let detached = 0;
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach() { attached = true; },
    detach() { attached = false; detached++; },
    async sendCommand() { return {}; },
  });
  const contents = {
    getURL: () => 'http://127.0.0.1:5000/', isDestroyed: () => false, isDevToolsOpened: () => false,
    debugger: debug,
    async executeJavaScript(expression: string) { return vm.runInContext(expression, renderer) as unknown; },
  };
  const main = vm.createContext({ AbortController, Error, setTimeout, clearTimeout,
    process: { mainModule: { require(name: string) {
      if (name !== 'electron') throw new Error('Unexpected module');
      return { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: contents }] } };
    } } },
  });
  return { renderer, main, debug, detached: () => detached,
    run: (scenario: string, timeoutMs = 1000) => vm.runInContext(
      `(${runRendererSession.toString()})(${JSON.stringify({ key: 'testSession', timeoutMs })}, ${JSON.stringify(scenario)})`, main) as Promise<SessionResult>,
  };
}

test('successful and failed scenarios both restore state and release the debugger', async () => {
  for (const fail of [false, true]) {
    const h = fixture();
    const result = await h.run(`async ui => {
      ui.cleanup('globalThis.value = "original"');
      await ui.evaluate('globalThis.value = "changed"');
      ${fail ? 'throw Error("scenario failed")' : 'return {checked:true}'};
    }`);
    expect(result.ok).toBe(!fail);
    expect(h.renderer.value).toBe('original');
    expect(h.detached()).toBe(1);
    expect(h.main.testSession).toBeUndefined();
    expect(result.cleanupErrors).toEqual([]);
  }
});

test('deadline restores state and prevents late helper actions', async () => {
  const h = fixture();
  const result = await h.run(`async ui => {
    ui.cleanup('globalThis.value = "original"');
    await ui.evaluate('globalThis.value = "changed"');
    await new Promise(r => setTimeout(r, 40));
    await ui.evaluate('globalThis.value = "late write"');
  }`, 10);
  expect(result.ok).toBe(false);
  expect(result.error).toContain('timed out');
  await Bun.sleep(60);
  expect(h.renderer.value).toBe('original');
  expect(h.detached()).toBe(1);
});

test('cleanup failures remain failures and do not skip other cleanup or detach', async () => {
  const h = fixture();
  const result = await h.run(`async ui => {
    ui.cleanup('globalThis.value = "restored"');
    ui.cleanup('(() => { throw Error("cleanup failed"); })()');
  }`);
  expect(result.ok).toBe(false);
  expect(result.cleanupErrors).toHaveLength(1);
  expect(h.renderer.value).toBe('restored');
  expect(h.detached()).toBe(1);
});

test('an existing renderer debugger is left untouched', async () => {
  const h = fixture(true);
  let failure: unknown;
  try { await h.run('async () => true'); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('already in use');
  expect(h.detached()).toBe(0);
  expect(h.debug.isAttached()).toBe(true);
});

test('renderer expressions work without unsafe-eval permission', async () => {
  const h = fixture();
  h.renderer.eval = () => { throw new Error('unsafe-eval forbidden'); };
  const result = await h.run('async ui => await ui.evaluate("2 + 2")');
  expect(result.ok).toBe(true);
  expect(result.result).toBe(4);
});
