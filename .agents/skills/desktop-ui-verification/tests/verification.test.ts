import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { runRendererSession, type SessionResult } from '../../desktop-ui-check/scripts/renderer-session.mts';
import { compileScenario, type VerificationScenario, type VerificationUI } from '../scripts/verification.mts';

function fixture() {
  const renderer = vm.createContext({ value: 'original', setTimeout });
  let attached = false;
  let detached = 0;
  let inputs = 0;
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach() { attached = true; },
    detach() { attached = false; detached++; },
    async sendCommand(method: string, params?: Record<string, unknown>) {
      if (method === 'Input.insertText') { renderer.value = params?.text; inputs++; }
      return {};
    },
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
  return { renderer, main, debug, inputs: () => inputs, detached: () => detached,
    run: (scenario: VerificationScenario, timeoutMs = 1000) => vm.runInContext(
      `(${runRendererSession.toString()})(${JSON.stringify({ key: 'verificationTest', timeoutMs })}, ${JSON.stringify(compileScenario(scenario).toString())})`, main,
    ) as Promise<SessionResult>,
  };
}

function scenario(overrides: Partial<VerificationScenario> = {}): VerificationScenario {
  return {
    name: 'typing', requiredChecks: ['typed'], precondition: 'globalThis.value === "original"',
    snapshot: 'globalThis.value', restore: 'globalThis.value = snapshot',
    restored: 'globalThis.value === snapshot',
    run: async function run(ui) {
      await ui.type('changed');
      await ui.check('typed', 'globalThis.value === "changed"');
    },
    ...overrides,
  };
}

function expectRestored(h: ReturnType<typeof fixture>) {
  expect(h.renderer.value).toBe('original');
  expect(h.renderer.verificationTest_verification).toBeUndefined();
  expect(h.main.verificationTest).toBeUndefined();
  expect(h.detached()).toBe(1);
}

test('serialized scenario uses real input, checks outcomes, restores and releases transport', async () => {
  const h = fixture();
  const report = await h.run(scenario());
  expect(report.ok).toBe(true);
  expect(report.result).toEqual({ checks: ['typed'], actions: 1, screenshots: [] });
  expect(report.cleanupErrors).toEqual([]);
  expect(h.inputs()).toBe(1);
  expectRestored(h);
});

test('incomplete contracts fail before connecting to the app', () => {
  for (const overrides of [
    { requiredChecks: [] }, { requiredChecks: ['same', 'same'] }, { restored: '' }, { restore: '' }, { snapshot: '' },
  ]) expect(() => compileScenario(scenario(overrides))).toThrow();
});

test('false or truthy preconditions cause no input or capture', async () => {
  for (const precondition of ['false', '"true"']) {
    const h = fixture();
    const report = await h.run(scenario({ precondition }));
    expect(report.ok).toBe(false);
    expect(report.error).toContain('precondition failed');
    expect(h.inputs()).toBe(0);
    expectRestored(h);
  }
});

test('a skipped required check fails even when run resolves', async () => {
  const h = fixture();
  const report = await h.run(scenario({ run: async function run(ui) { await ui.type('changed'); } }));
  expect(report.ok).toBe(false);
  expect(report.error).toContain('Missing required checks: typed');
  expectRestored(h);
});

test('false and truthy assertion values never pass', async () => {
  for (const expression of ['false', '1', '"true"', '({passed:true})']) {
    const h = fixture();
    const report = await h.run(scenario({
      run: new Function(`return async ui => { await ui.type('changed'); await ui.check('typed', ${JSON.stringify(expression)}); }`)() as VerificationScenario['run'],
    }));
    expect(report.ok).toBe(false);
    expect(report.error).toContain('Check failed: typed');
    expectRestored(h);
  }
});

test('a caught failed assertion cannot later turn into a pass', async () => {
  const h = fixture();
  const report = await h.run(scenario({ run: async function run(ui) {
    await ui.type('changed');
    try { await ui.check('typed', 'false'); } catch { /* Deliberately exercise a scenario swallowing failure. */ }
    await ui.check('typed', 'true');
  } }));
  expect(report.ok).toBe(false);
  expect(report.error).toContain('Check failed: typed');
  expectRestored(h);
});

test('a returned verdict cannot substitute for check assertions', async () => {
  const h = fixture();
  const report = await h.run(scenario({
    // Malformed scenario boundary: the API intentionally disallows returned verdicts.
    run: (async (ui: VerificationUI) => {
      await ui.type('changed'); await ui.check('typed', 'true'); return { passed: false };
    }) as unknown as VerificationScenario['run'],
  }));
  expect(report.ok).toBe(false);
  expect(report.error).toContain('must not return a result');
  expectRestored(h);
});

test('DOM-only mutations do not count as real input', async () => {
  const h = fixture();
  const report = await h.run(scenario({ run: async function run(ui) {
    await ui.evaluate('globalThis.value = "changed"'); await ui.check('typed', 'true');
  } }));
  expect(report.ok).toBe(false);
  expect(report.error).toContain('No real user input');
  expectRestored(h);
});

test('restoration verification failure and thrown cleanup both fail the overall run', async () => {
  for (const overrides of [
    { restored: 'false' }, { restored: '"true"' },
    { restore: '(() => { globalThis.value = snapshot; throw Error("restore error"); })()' },
  ]) {
    const h = fixture();
    const report = await h.run(scenario(overrides));
    expect(report.ok).toBe(false);
    expect(report.cleanupErrors).toHaveLength(1);
    expect(report.cleanupErrors[0]).toContain('Restoration');
    expectRestored(h);
  }
});

test('restoration verification still runs after a restoration exception', async () => {
  const h = fixture();
  const report = await h.run(scenario({ restore: '(() => { throw Error("restore error"); })()',
    restored: '(globalThis.verified = true, globalThis.value === snapshot)' }));
  expect(report.ok).toBe(false);
  expect(report.cleanupErrors[0]).toContain('Restoration failed');
  expect(report.cleanupErrors[0]).toContain('Restoration verification failed');
  expect(h.renderer.verified).toBe(true);
  expect(h.renderer.verificationTest_verification).toBeUndefined();
  expect(h.detached()).toBe(1);
});

test('deadline restores state and blocks late input after scenario cancellation', async () => {
  const h = fixture();
  const report = await h.run(scenario({ run: async function run(ui) {
    await ui.type('changed');
    await new Promise(resolve => setTimeout(resolve, 100));
    await ui.type('late');
    await ui.check('typed', 'true');
  } }), 30);
  expect(report.ok).toBe(false);
  expect(report.error).toContain('timed out');
  await Bun.sleep(150);
  expect(h.inputs()).toBe(1);
  expectRestored(h);
});

test('runtime exceptions reported by the shared transport fail verification', async () => {
  const h = fixture();
  h.renderer.emitException = () => h.debug.emit('message', {}, 'Runtime.exceptionThrown');
  const report = await h.run(scenario({ run: async function run(ui) {
    await ui.type('changed'); await ui.evaluate('emitException()'); await ui.check('typed', 'true');
  } }));
  expect(report.ok).toBe(false);
  expect(report.runtimeExceptions).toBe(1);
  expectRestored(h);
});
