import type { DesktopUI } from '../../desktop-ui-check/scripts/renderer-session.mts';

export interface VerificationUI {
  evaluate: DesktopUI['evaluate'];
  waitFor: DesktopUI['waitFor'];
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  key(key: 'Escape' | 'Tab', modifiers?: number): Promise<void>;
  check(name: string, expression: string): Promise<void>;
  screenshot(name: string): Promise<void>;
}

export interface VerificationScenario {
  name: string;
  requiredChecks: string[];
  /** Renderer expressions. Snapshot must be synchronous and read-only. */
  precondition: string;
  snapshot: string;
  /** These expressions can access the private renderer-local `snapshot`. */
  restore: string;
  restored: string;
  /** Self-contained function: no runtime imports or enclosing variables. */
  run(ui: VerificationUI): Promise<void>;
}

export interface VerificationResult {
  checks: string[];
  actions: number;
  screenshots: { name: string; data: string }[];
}

export function validateScenario(scenario: VerificationScenario) {
  if (!scenario || typeof scenario !== 'object') throw new Error('Expected a scenario object');
  for (const name of ['name', 'precondition', 'snapshot', 'restore', 'restored'] as const) {
    if (typeof scenario[name] !== 'string' || !scenario[name].trim()) throw new Error(`Missing scenario ${name}`);
  }
  if (!Array.isArray(scenario.requiredChecks) || !scenario.requiredChecks.length
    || scenario.requiredChecks.some(name => typeof name !== 'string' || !name.trim())
    || new Set(scenario.requiredChecks).size !== scenario.requiredChecks.length) {
    throw new Error('requiredChecks must contain unique, nonempty names');
  }
  if (typeof scenario.run !== 'function') throw new Error('Missing scenario run function');
}

/** Serialized into Electron; keep all runtime dependencies inside this function. */
async function verifyScenario(ui: DesktopUI, scenario: VerificationScenario): Promise<VerificationResult> {
  const slot = JSON.stringify(`${ui.key}_verification`);
  const checks = new Set<string>();
  const failures: string[] = [];
  const screenshots: VerificationResult['screenshots'] = [];
  let actions = 0;
  const fail = (message: string): never => { failures.push(message); throw new Error(message); };
  if (await ui.evaluate(scenario.precondition) !== true) fail('Scenario precondition failed; no actions performed');
  // Register before snapshot capture so a deadline cannot leave an orphaned snapshot.
  ui.cleanup(`(async () => {
    const entry = globalThis[${slot}];
    if (!entry) return;
    const snapshot = entry.snapshot;
    const errors = [];
    try {
      try { await (${scenario.restore}); }
      catch (error) { errors.push('Restoration failed: ' + String(error)); }
      try {
        if (await (${scenario.restored}) !== true) errors.push('Restoration verification failed');
      } catch (error) { errors.push('Restoration verification failed: ' + String(error)); }
    } finally { delete globalThis[${slot}]; }
    if (errors.length) throw Error(errors.join('; '));
  })()`);
  await ui.evaluate(`(() => {
    const snapshot = (${scenario.snapshot});
    if (snapshot && typeof snapshot.then === 'function') throw Error('Snapshot must be synchronous');
    globalThis[${slot}] = {snapshot};
    return true;
  })()`);
  const input: VerificationUI = {
    evaluate: ui.evaluate,
    waitFor: ui.waitFor,
    async click(selector) { await ui.click(selector); actions++; },
    async type(text) {
      if (typeof text !== 'string' || !text.length) fail('Input text must be nonempty');
      await ui.cdp('Input.insertText', { text }); actions++;
    },
    async key(key, modifiers = 0) {
      if (!['Escape', 'Tab'].includes(key)) fail('Only non-submitting Escape and Tab keys are supported');
      const params = { key, code: key, modifiers, windowsVirtualKeyCode: key === 'Escape' ? 27 : 9 };
      await ui.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      await ui.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      actions++;
    },
    async check(name, expression) {
      if (!scenario.requiredChecks.includes(name) || checks.has(name)) fail(`Undeclared or duplicate check: ${name}`);
      const value = await ui.evaluate(expression).catch(error => fail(`Check ${name} threw: ${String(error)}`));
      if (value !== true) fail(`Check failed: ${name}`);
      checks.add(name);
    },
    async screenshot(name) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || screenshots.some(item => item.name === name)) {
        fail('Screenshot names must be unique lowercase file stems');
      }
      const result = await ui.cdp('Page.captureScreenshot', { format: 'png' }) as { data?: unknown };
      if (typeof result.data !== 'string' || !result.data) fail('Screenshot capture returned no image');
      screenshots.push({ name, data: result.data as string });
    },
  };
  const returned = await scenario.run(input);
  if (returned !== undefined) fail('Use ui.check for verdicts; run must not return a result');
  if (!actions) fail('No real user input was performed');
  const missing = scenario.requiredChecks.filter(name => !checks.has(name));
  if (missing.length) fail(`Missing required checks: ${missing.join(', ')}`);
  if (failures.length) throw new Error(failures.join('; '));
  return { checks: [...checks], actions, screenshots };
}

export function compileScenario(scenario: VerificationScenario): (ui: DesktopUI) => Promise<VerificationResult> {
  validateScenario(scenario);
  const { run, ...metadata } = scenario;
  const source = `async function verification(ui) {
    const scenario = {...${JSON.stringify(metadata)}, run: (${run.toString()})};
    return await (${verifyScenario.toString()})(ui, scenario);
  }`;
  // Trusted local scenario code, serialized exactly as the shared runner requires.
  return new Function(`return (${source})`)() as (ui: DesktopUI) => Promise<VerificationResult>;
}
