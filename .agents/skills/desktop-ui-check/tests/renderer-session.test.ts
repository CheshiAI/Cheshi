import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { runRendererSession, type SessionResult } from '../scripts/renderer-session.mts';

function fixture(alreadyAttached = false, extraUrls: string[] = [], workspace = true) {
  const renderer = vm.createContext({ value: 'original', setTimeout });
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
  const main = vm.createContext({ URL, AbortController, Error, setTimeout, clearTimeout,
    process: { mainModule: { require(name: string) {
      if (name !== 'electron') throw new Error('Unexpected module');
      return { BrowserWindow: { getAllWindows: () => [
        ...(workspace ? [{ isDestroyed: () => false, webContents: contents }] : []),
        ...extraUrls.map(url => ({ isDestroyed: () => false, webContents: {
          getURL: () => url, isDevToolsOpened: () => { throw new Error('Unexpected window selected'); },
        } })),
      ] } };
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

test('default wait succeeds after five seconds within the scenario deadline', async () => {
  const h = fixture();
  const result = await h.run(`async ui => {
    ui.cleanup('delete globalThis.readyAt');
    await ui.evaluate('globalThis.readyAt = Date.now() + 5200');
    await ui.waitFor('Date.now() >= globalThis.readyAt');
    return { ready: true };
  }`, 8000);
  expect(result.ok).toBe(true);
  expect(result.result).toEqual({ ready: true });
  expect(h.renderer.readyAt).toBeUndefined();
  expect(h.detached()).toBe(1);
}, 10000);

test('explicit wait limits fail and restore state even for a pending renderer evaluation', async () => {
  for (const expression of ['false', '"truthy"', 'new Promise(resolve => setTimeout(() => resolve(true), 150))']) {
    const h = fixture();
    const result = await h.run(`async ui => {
      ui.cleanup('globalThis.value = "original"');
      await ui.evaluate('globalThis.value = "changed"');
      await ui.waitFor(${JSON.stringify(expression)}, 20);
      await ui.evaluate('globalThis.value = "late write"');
    }`);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('UI condition did not become true within 20 ms');
    await Bun.sleep(170);
    expect(h.renderer.value).toBe('original');
    expect(h.detached()).toBe(1);
    expect(result.cleanupErrors).toEqual([]);
  }
});

test('default and longer explicit waits share the remaining scenario deadline', async () => {
  for (const extra of ['', ', 1000']) {
    const h = fixture();
    const result = await h.run(`async ui => {
      ui.cleanup('globalThis.value = "original"');
      await ui.evaluate('globalThis.value = "changed"');
      await new Promise(resolve => setTimeout(resolve, 30));
      await ui.waitFor('false'${extra});
      await ui.evaluate('globalThis.value = "late write"');
    }`, 60);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    await Bun.sleep(60);
    expect(h.renderer.value).toBe('original');
    expect(h.detached()).toBe(1);
    expect(h.main.testSession).toBeUndefined();
  }
});

test('cancelling a pending wait restores state and stops further polling', async () => {
  const h = fixture();
  const result = await h.run(`async ui => {
    ui.cleanup('globalThis.value = "original"');
    await ui.evaluate('globalThis.value = "changed"');
    setTimeout(() => globalThis.testSession.abort(), 10);
    await ui.waitFor('(globalThis.polls = (globalThis.polls || 0) + 1, false)');
    await ui.evaluate('globalThis.value = "late write"');
  }`);
  const polls = h.renderer.polls;
  expect(result.ok).toBe(false);
  expect(result.error).toContain('cancelled');
  await Bun.sleep(60);
  expect(h.renderer.polls).toBe(polls);
  expect(h.renderer.value).toBe('original');
  expect(h.detached()).toBe(1);
});

test('wait rejects invalid limits without evaluating the condition', async () => {
  for (const limit of ['0', '-1', '1.5', 'NaN', 'Infinity', '"20"', 'null']) {
    const h = fixture();
    const result = await h.run(`async ui => await ui.waitFor('(globalThis.value = "unexpected", true)', ${limit})`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('positive integer');
    expect(h.renderer.value).toBe('original');
    expect(h.detached()).toBe(1);
  }
});


test('memo windows are excluded while multiple workspace windows remain ambiguous', async () => {
  const notes = ['http://127.0.0.1:5000/?stickyNotes=1', 'http://127.0.0.1:5000/?project=test&stickyNotes=1'];
  const h = fixture(false, notes);
  expect((await h.run('async ui => await ui.evaluate("2 + 2")')).result).toBe(4);
  expect(h.detached()).toBe(1);
  for (const [urls, workspace, count] of [[notes, false, 0], [['http://127.0.0.1:5000/?project=other'], true, 2]] as const) {
    const ambiguous = fixture(false, [...urls], workspace);
    let failure: unknown;
    try { await ambiguous.run('async () => true'); } catch (error) { failure = error; }
    expect(String(failure)).toContain(`found ${count}`);
    expect(ambiguous.detached()).toBe(0);
  }
});
