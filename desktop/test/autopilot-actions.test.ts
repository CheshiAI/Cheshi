import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createContext, runInContext } from 'node:vm';
import { autopilotActions, autopilotInteractionKey } from '../lib/autopilot-actions.mts';
import type { AutopilotControl, AutopilotInteraction } from '../lib/autopilot-actions.mts';
import { createAutopilotModel } from '../lib/autopilot-model.mts';
import type { AutopilotDecision, AutopilotPage } from '../lib/autopilot-model.mts';
import { AUTOPILOT_PAGE_SCRIPT, autopilotInteractionScript, parseAutopilotPage } from '../lib/autopilot-page.mts';
import { performAutopilotInteraction } from '../lib/autopilot-interaction.mts';
import { AutopilotPageChangedError, createAutopilotRunner } from '../lib/autopilot-runner.mts';
import { parseAutopilotRequest, parseAutopilotState } from '../shared/autopilot.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const input: AutopilotControl = { id: 'control_1', kind: 'input', label: 'Search', signature: 'search', value: '' };
const button: AutopilotControl = { id: 'control_2', kind: 'button', label: 'Search', signature: 'submit', value: '' };
const start: AutopilotPage = { url: 'https://example.org/', title: 'Search', text: 'Search site', links: [], controls: [input, button] };
const fill: AutopilotInteraction = { kind: 'fill', control: input, text: 'Manipuri pony' };

function dom(markup: string) {
  const window = new Window({ url: start.url });
  window.document.write(markup);
  window.HTMLElement.prototype.getClientRects = function (this: InstanceType<typeof window.HTMLElement>) {
    return this.hidden ? [] : [{}];
  } as typeof window.HTMLElement.prototype.getClientRects;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const context = createContext({ document: window.document, location: window.location, URL,
    getComputedStyle: window.getComputedStyle.bind(window), HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, Event: window.Event });
  const evaluate = (code: string): unknown => runInContext(code, context);
  const read = () => parseAutopilotPage(evaluate(AUTOPILOT_PAGE_SCRIPT));
  return { window, read, evaluate, close: () => window.happyDOM.close() };
}

async function failure(operation: Promise<unknown>, message: string) {
  let error: unknown;
  try { await operation; } catch (cause) { error = cause; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

test('search text is bounded and optional; actions and state survive the IPC boundary', () => {
  expect(parseAutopilotRequest({ url: start.url, goal: 'Find it', searchText: '  pony  ' }).searchText).toBe('pony');
  for (const searchText of [true, null, 'a'.repeat(501)]) {
    expect(() => parseAutopilotRequest({ url: start.url, goal: 'Find it', searchText })).toThrow();
  }
  expect(autopilotActions(start, [], '')).toEqual([]);
  expect(autopilotActions(start, [], fill.text).map(action => action.kind)).toEqual(['fill', 'click']);
});

test('DOM extraction excludes unavailable fields and preserves node identities across reads', async () => {
  const h = dom('<label for="q">Search articles</label><input id="q" type="search"><button>Search</button>'
    + '<input type="password" aria-label="Password"><input hidden aria-label="Hidden"><input readonly aria-label="Readonly">'
    + '<input disabled aria-label="Disabled"><button aria-disabled="true">Unavailable</button>'
    + '<form method="post"><input aria-label="Post"><button>Submit</button></form>');
  try {
    const first = h.read();
    expect(first.controls?.map(control => control.label)).toEqual(['Search articles', 'Search']);
    expect(h.read().controls).toEqual(first.controls);
    expect(() => parseAutopilotPage({ ...first, controls: [first.controls![0], first.controls![0]] })).toThrow('Invalid page control');
  } finally { await h.close(); }
});

test('input executes native value changes and events while stale replacement nodes cannot be clicked', async () => {
  const h = dom('<input type="search" aria-label="Search"><button id="submit">Search</button>');
  try {
    const current = h.read();
    const text = 'pony " \\ ${globalThis.injected = true}';
    const action: AutopilotInteraction = { kind: 'fill', control: current.controls![0]!, text };
    const events: string[] = [];
    const field = h.window.document.querySelector('input')!;
    for (const event of ['input', 'change']) field.addEventListener(event, () => events.push(event));
    expect(h.evaluate(autopilotInteractionScript(current.url, action))).toBe('applied');
    expect(field.value).toBe(text);
    expect(events).toEqual(['input', 'change']);
    const click: AutopilotInteraction = { kind: 'click', control: current.controls![1]! };
    h.window.document.querySelector('button')!.outerHTML = '<button id="submit">Search</button>';
    let clicked = 0;
    h.window.document.querySelector('button')!.addEventListener('click', () => clicked++);
    expect(h.evaluate(autopilotInteractionScript(current.url, click))).toBe('stale');
    expect(clicked).toBe(0);
    h.read();
    expect(h.evaluate(autopilotInteractionScript(current.url, click))).toBe('stale');
  } finally { await h.close(); }
});

test('Jev chooses only supplied actions and receives exact search text and prior actions', async () => {
  const choose = (selected: string) => createAutopilotModel('fixture-key', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-latest');
    expect(body.state.searchText).toBe(fill.text);
    expect(body.state.history).toEqual(['Open: Search']);
    expect(Object.keys(body.questions.links_0.criteria)).toEqual(['fill_control_1', 'click_control_2']);
    return Response.json({ answers: { completion: { type: 'choice', choice: 'continue', confidence: 1 },
      links_0: { type: 'choice', choice: selected, confidence: 1 } } });
  });
  const args = { page: start, goal: 'Find pony', visited: [start.url], searchText: fill.text,
    history: ['Open: Search'], signal: new AbortController().signal };
  expect((await choose('fill_control_1')(args)).interaction).toEqual(fill);
  expect((await choose('click_control_2')(args)).interaction?.kind).toBe('click');
  await failure(choose('invented')(args), 'invalid choice');
});

test('interaction waits for retained input and for results that update without navigating', async () => {
  const h = dom('<input type="search" aria-label="Search"><button>Search</button><main>Enter a query</main>');
  try {
    const options = { read: async () => h.read(), evaluate: async (code: string) => h.evaluate(code),
      loading: () => false, timeoutMs: 100, pollMs: 1, settleMs: 2 };
    const before = h.read();
    const after = await performAutopilotInteraction(options, before,
      { kind: 'fill', control: before.controls![0]!, text: fill.text }, new AbortController().signal);
    expect(after.controls![0]!.value).toBe(fill.text);
    h.window.document.querySelector('button')!.addEventListener('click', () => {
      h.window.document.querySelector('main')!.textContent = 'Results: Manipuri pony';
    });
    const results = await performAutopilotInteraction(options, after,
      { kind: 'click', control: after.controls![1]! }, new AbortController().signal);
    expect(results.url).toBe(before.url);
    expect(results.text).toContain('Results: Manipuri pony');
  } finally { await h.close(); }
});

test('unresponsive clicks are not replayed and input rejected by a framework is reported', async () => {
  let executed = 0;
  const options = { read: async () => start, loading: () => false,
    evaluate: async () => { executed++; return 'applied'; }, timeoutMs: 10, pollMs: 1, settleMs: 1 };
  await failure(performAutopilotInteraction(options, start, { kind: 'click', control: button }, new AbortController().signal), 'no confirmed page change');
  expect(executed).toBe(1);
  await failure(performAutopilotInteraction(options, start, fill, new AbortController().signal), 'did not retain');
  expect(executed).toBe(2);
});

test('a stale control triggers refresh before execution and stop aborts result observation', async () => {
  let executed = 0;
  const options = { read: async () => ({ ...start, controls: [] }), loading: () => false,
    evaluate: async () => { executed++; return 'applied'; }, pollMs: 1 };
  await failure(performAutopilotInteraction(options, start, fill, new AbortController().signal), 'page changed');
  expect(executed).toBe(0);
  const controller = new AbortController();
  const pending = performAutopilotInteraction({ ...options, read: async () => start,
    evaluate: async () => { controller.abort(); return 'applied'; } }, start, fill, controller.signal);
  await failure(pending, 'abort');
});

test('runner records fill and click on the same URL, checks results, and rejects repeated clicks', async () => {
  let interactions = 0;
  const runner = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {}, load: async () => start,
    follow: async () => { throw new Error('Unexpected navigation'); },
    interact: async (page, action) => {
      interactions++;
      return action.kind === 'fill' ? { ...page, controls: [{ ...input, value: fill.text }, button] }
        : { ...page, text: 'Results: Manipuri pony' };
    },
    decide: async ({ page, searchText }): Promise<AutopilotDecision> => ({ link: null, confidence: 1,
      completed: page.text.startsWith('Results'), interaction: page.controls?.[0]?.value === searchText
        ? { kind: 'click', control: button } : fill }),
  });
  runner.start({ url: start.url, goal: 'Find results', searchText: fill.text });
  await flush();
  const state = parseAutopilotState(runner.snapshot());
  expect(state.phase).toBe('completed');
  expect(state.steps.map(step => step.action)).toEqual([undefined, `Type: ${fill.text}`, 'Click: Search']);
  expect(interactions).toBe(2);
  runner.dispose();

  const endless = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {}, load: async () => start,
    follow: async () => start, interact: async () => start,
    decide: async () => ({ link: null, confidence: 1, completed: false, interaction: { kind: 'click', control: button } }),
  });
  endless.start({ url: start.url, goal: 'Never complete', searchText: fill.text });
  await flush();
  expect(endless.snapshot().phase).toBe('error');
  expect(endless.snapshot().steps).toHaveLength(2);
  endless.dispose();
});

test('runner rejects invented text and cannot resume an interaction after stop and restart', async () => {
  let resolve!: (page: AutopilotPage) => void;
  const pending = new Promise<AutopilotPage>(done => { resolve = done; });
  let interactions = 0;
  let mode: 'invalid' | 'pending' | 'complete' = 'invalid';
  const runner = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {}, load: async () => start,
    follow: async () => start, interact: async () => { interactions++; return pending; },
    decide: async () => ({ link: null, completed: mode === 'complete', confidence: 1,
      interaction: mode === 'invalid' ? { ...fill, text: 'invented' } : fill }),
  });
  runner.start({ url: start.url, goal: 'Find results', searchText: fill.text });
  await flush();
  expect(runner.snapshot().phase).toBe('error');
  expect(interactions).toBe(0);
  mode = 'pending';
  runner.start({ url: start.url, goal: 'First', searchText: fill.text });
  await flush();
  expect(runner.stop().phase).toBe('stopped');
  mode = 'complete';
  runner.start({ url: start.url, goal: 'Second' });
  await flush();
  resolve(start);
  await flush();
  expect(runner.snapshot().phase).toBe('completed');
  expect(runner.snapshot().goal).toBe('Second');
  expect(runner.snapshot().searchText).toBeUndefined();
  expect(runner.snapshot().steps).toHaveLength(1);
  runner.dispose();
});

test('runner reselects refreshed controls without duplicating a same-page history entry', async () => {
  let decisions = 0;
  const refreshed = { ...start, title: 'Updated search', controls: [{ ...input, id: 'control_3' }] };
  const runner = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {}, load: async () => start,
    follow: async () => start, interact: async () => { throw new AutopilotPageChangedError(refreshed); },
    decide: async ({ page }) => { decisions++; return { link: null, completed: page.title === refreshed.title,
      interaction: fill, confidence: 1 }; },
  });
  runner.start({ url: start.url, goal: 'Search', searchText: fill.text });
  await flush();
  expect(decisions).toBe(2);
  expect(runner.snapshot().phase).toBe('completed');
  expect(runner.snapshot().steps).toHaveLength(1);
  runner.dispose();
});


test('textarea search controls retain native input events and reject stale replacements', async () => {
  const h = dom('<form method="get"><textarea aria-label="Search" role="combobox"></textarea><button>Search</button></form>'
    + '<textarea readonly aria-label="Readonly"></textarea><textarea disabled aria-label="Disabled"></textarea>'
    + '<form method="post"><textarea aria-label="Message"></textarea></form>');
  try {
    const before = h.read();
    expect(before.controls?.map(control => control.label)).toEqual(['Search', 'Search']);
    const field = h.window.document.querySelector('textarea')!;
    const events: string[] = [];
    for (const name of ['input', 'change']) field.addEventListener(name, () => events.push(name));
    const action: AutopilotInteraction = { kind: 'fill', control: before.controls![0]!, text: 'TypeSafe AI Jev' };
    const after = await performAutopilotInteraction({ read: async () => h.read(), evaluate: async code => h.evaluate(code),
      loading: () => false, timeoutMs: 100, pollMs: 1, settleMs: 2 }, before, action, new AbortController().signal);
    expect(after.controls![0]!.value).toBe(action.text);
    expect(events).toEqual(['input', 'change']);
    field.outerHTML = '<textarea aria-label="Search" role="combobox"></textarea>';
    expect(h.evaluate(autopilotInteractionScript(before.url, action))).toBe('stale');
  } finally { await h.close(); }
});

test('model excludes completed interactions even after a button is recreated or toggled', async () => {
  const key = autopilotInteractionKey(start.url, { kind: 'click', control: button });
  const changed = { ...start, controls: [input, { ...button, id: 'control_9', signature: 'expanded' }] };
  const model = createAutopilotModel('fixture', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body.questions.links_0.criteria)).toEqual(['fill_control_1']);
    return Response.json({ answers: { completion: { type: 'choice', choice: 'continue', confidence: 1 },
      links_0: { type: 'choice', choice: 'fill_control_1', confidence: 1 } } });
  });
  expect((await model({ page: changed, goal: 'Find it', searchText: fill.text, visited: [],
    completedInteractions: [key], signal: new AbortController().signal })).interaction).toEqual(fill);
  expect(autopilotActions({ ...changed, url: 'https://example.org/other' }, [], fill.text, [key])).toHaveLength(2);
});
