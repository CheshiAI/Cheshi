import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createBrowserApis } from '../lib/browser-preload.cts';
import { readAutopilotKey } from '../lib/autopilot-key.mts';
import { createAutopilotModel } from '../lib/autopilot-model.mts';
import { AUTOPILOT_REQUEST_BYTES, evaluateAutopilotQuestions } from '../lib/autopilot-model-request.mts';
import type { ChoiceQuestion } from '../lib/autopilot-model-request.mts';
import type { AutopilotDecision, AutopilotPage } from '../lib/autopilot-model.mts';
import { AUTOPILOT_PAGE_SCRIPT, autopilotOperation, parseAutopilotPage } from '../lib/autopilot-page.mts';
import { AutopilotPageChangedError, createAutopilotRunner } from '../lib/autopilot-runner.mts';
import { AUTOPILOT_CHANNELS, AUTOPILOT_MAX_STEPS, parseAutopilotRequest, parseAutopilotView, safeAutopilotUrl } from '../shared/autopilot.ts';
import type { AutopilotState } from '../shared/autopilot.ts';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function rejection(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const page = (name: string, next: string[] = []): AutopilotPage => ({ url: `https://example.org/${name}`,
  title: name, text: name, links: next.map((name, index) => ({ id: `link_${index}`, url: `https://example.org/${name}`, label: name })) });

test('browser preload preserves Showcase and validates Autopilot requests and returned state', async () => {
  const requests: Array<{ channel: string; value: unknown }> = [];
  const state: AutopilotState = { configured: true, phase: 'idle', url: '', title: '', goal: '', error: null, modelMs: 0, steps: [] };
  const ipc = Object.assign(new EventEmitter(), {
    async invoke(channel: string, value: unknown) { requests.push({ channel, value }); return state; },
  }) as unknown as Parameters<typeof createBrowserApis>[0];
  const api = createBrowserApis(ipc);
  expect(await api.autopilot.getState()).toEqual(state);
  await api.autopilot.start({ url: 'https://example.org/#part', goal: 'Target' });
  expect(requests.at(-1)).toEqual({ channel: AUTOPILOT_CHANNELS.start, value: { url: 'https://example.org/', goal: 'Target' } });
  await api.showcase.navigate('back');
  expect(requests.at(-1)?.channel).toBe('cheshi:showcase:navigate');
  await rejection(api.autopilot.start({ url: 'file:///private', goal: 'Target' }), 'valid HTTP');
  expect(requests).toHaveLength(3);
});

test('key loading uses the named environment value and development fallback without importing signing variables', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cheshi-autopilot-key-'));
  try {
    const developmentFile = path.join(directory, '.env.signing');
    writeFileSync(developmentFile, 'TYPE_SAFE_AI="fixture-value"\nUNRELATED_SIGNING_VALUE=private-fixture\n');
    const environment: NodeJS.ProcessEnv = {};
    expect(readAutopilotKey({ environment, developmentFile })).toBe('fixture-value');
    expect(environment).toEqual({});
    expect(readAutopilotKey({ environment: { TYPE_SAFE_AI: 'environment-value' }, developmentFile })).toBe('environment-value');
    expect(readAutopilotKey({ environment })).toBeNull();
    expect(readAutopilotKey({ environment, developmentFile: path.join(directory, 'missing') })).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('IPC rejects executable URLs, credential URLs, empty goals, invalid bounds and truthy flags', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.org', 'data:text/html,test']) {
    expect(safeAutopilotUrl(url)).toBeNull();
    expect(() => parseAutopilotRequest({ url, goal: 'Explore' })).toThrow();
  }
  expect(() => parseAutopilotRequest({ url: 'https://example.org', goal: ' ' })).toThrow();
  expect(parseAutopilotRequest({ url: 'https://example.org/#section', goal: ' Goal ' }))
    .toEqual({ url: 'https://example.org/', goal: 'Goal' });
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  for (const visible of [1, 'true', null]) expect(() => parseAutopilotView({ visible, bounds })).toThrow();
  expect(() => parseAutopilotView({ visible: true, bounds: { ...bounds, width: -1 } })).toThrow();
});

test('page extraction supplies actual distinct HTTP links and excludes hidden or downloadable elements', () => {
  const anchor = (href: string, extra = {}) => ({ href, innerText: 'Link', title: '',
    hasAttribute: () => false, getClientRects: () => [{}], getAttribute: () => null, ...extra });
  const anchors = [anchor('https://example.org/a'), anchor('https://example.org/a#part'),
    anchor('javascript:alert(1)'), anchor('https://example.org/hidden', { getClientRects: () => [] }),
    anchor('https://example.org/download', { hasAttribute: () => true }), anchor('https://example.org/b')];
  const result: unknown = runInNewContext(AUTOPILOT_PAGE_SCRIPT, { URL, location: { href: 'https://example.org/' },
    getComputedStyle: () => ({ visibility: 'visible' }), document: { title: 'Start', querySelectorAll: () => anchors,
      querySelector: () => ({ innerText: 'Read the page' }) } });
  const snapshot = parseAutopilotPage(result);
  expect(snapshot.links.map(link => link.url)).toEqual(['https://example.org/a', 'https://example.org/b']);
  expect(snapshot.text).toBe('Read the page');
  expect(() => parseAutopilotPage({ ...snapshot, links: Array(4097).fill({}) })).toThrow('too many links');
});

test('model uses candidate IDs, honors the 255-option limit and chooses among group winners', async () => {
  const current = page('start', Array.from({ length: 600 }, (_, index) => String(index)));
  const calls: Array<Record<string, { criteria: Record<string, string> }>> = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body));
    expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(AUTOPILOT_REQUEST_BYTES);
    expect(body.model).toBe('jev-latest');
    calls.push(body.questions);
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      expect(options.length).toBeLessThanOrEqual(255);
      return [id, { type: 'choice', choice: id === 'completion' ? 'continue' : options.at(-1), confidence: 0.9 }];
    }));
    return Response.json({ answers });
  });
  const result = await createAutopilotModel('fixture-key', request)({ page: current, goal: 'Find 599',
    visited: [current.url], signal: new AbortController().signal });
  expect(calls.length).toBeGreaterThan(1);
  expect(Object.keys(calls.at(-1)!.next!.criteria)).toEqual(['none', 'link_253', 'link_507', 'link_599']);
  expect(result.link?.url).toBe('https://example.org/599');
});

test('model reports structured provider errors without echoing credentials or request payloads', async () => {
  const input = { page: page('start'), goal: 'Target', visited: [], signal: new AbortController().signal };
  const key = 'fixture-private-key';
  for (const [body, expected] of [
    [{ detail: { error_type: 'max_tokens_exceeded' } }, 'max_tokens_exceeded'],
    [{ error: { code: 'invalid_request', message: `Invalid request ${key} Bearer other-credential` },
      input: 'private page content', headers: { Authorization: 'Bearer hidden-header' } }, 'invalid_request'],
    [{ detail: [{ msg: 'Too many choices', input: { api_key: 'hidden-input' } }] }, 'Too many choices'],
  ] as const) {
    let message = '';
    try { await createAutopilotModel(key, async () => Response.json(body, { status: 400 }))(input); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('TypeSafe request failed (400).');
    expect(message).toContain(expected);
    for (const secret of [key, 'other-credential', 'hidden-header', 'hidden-input', 'private page content']) {
      expect(message).not.toContain(secret);
    }
  }
});

test('provider diagnostics handle plain text, HTML, large bodies, stream failures and stop', async () => {
  const input = { page: page('start'), goal: 'Target', visited: [], signal: new AbortController().signal };
  await rejection(createAutopilotModel('fixture-key', async () => new Response('upstream temporarily unavailable', { status: 502 }))(input),
    'upstream temporarily unavailable');
  for (const response of [new Response('<html>private proxy details</html>', { status: 502 }),
    new Response('x'.repeat(20_000), { status: 400 }),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error('private stream failure')); } }), { status: 400 })]) {
    let message = '';
    try { await createAutopilotModel('fixture-key', async () => response)(input); }
    catch (error) { message = (error as Error).message; }
    expect(message).toBe(`TypeSafe request failed (${response.status}).`);
  }
  const controller = new AbortController();
  const model = createAutopilotModel('fixture-key', async () => new Response(new ReadableStream({
    pull() { controller.abort(new Error('Stopped while reading diagnostics')); },
  }), { status: 400 }));
  await rejection(model({ ...input, signal: controller.signal }), 'Stopped while reading diagnostics');
});

test('large multilingual controls and links stay within request budget without losing late candidates', async () => {
  const current: AutopilotPage = { ...page('large'), text: '공개 페이지 '.repeat(1000),
    controls: Array.from({ length: 256 }, (_, i) => ({ id: `control_${i}`, kind: 'button', label: `언어 메뉴 ${i}`, value: '',
      signature: `private-local-signature-${i}`, identity: `private-dom-path-${i}`, context: '반복된 주변 텍스트 '.repeat(150) })),
    links: Array.from({ length: 600 }, (_, i) => ({ id: `link_${i}`, label: `문서 ${i} ` + '설명'.repeat(120), url: `https://example.org/${i}` })) };
  const seen = new Set<string>();
  let calls = 0;
  const model = createAutopilotModel('fixture-key', async (_url, init) => {
    calls++;
    const raw = String(init.body);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(AUTOPILOT_REQUEST_BYTES);
    expect(raw).not.toContain('private-local-signature');
    expect(raw).not.toContain('private-dom-path');
    expect(raw).not.toContain('private-outcome-key');
    const body = JSON.parse(raw) as { state: { goal: string; searchText: string }; questions: Record<string, ChoiceQuestion> };
    expect(body.state.goal).toBe('문서 599로 이동');
    expect(body.state.searchText).toBe('정확한 검색어');
    return Response.json({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const candidates = Object.keys(question.criteria);
      expect(candidates.length).toBeLessThanOrEqual(255);
      for (const candidate of candidates) if (candidate.startsWith('link_')) seen.add(candidate);
      return [id, { type: 'choice', confidence: 0.9,
        choice: id === 'completion' ? 'continue' : candidates.at(-1) }];
    })) });
  });
  const result = await model({ page: current, goal: '문서 599로 이동', searchText: '정확한 검색어', visited: [],
    outcomes: [{ url: current.url, action: 'Click: old', key: 'private-outcome-key', status: 'verified' }],
    signal: new AbortController().signal });
  expect(calls).toBeGreaterThan(2);
  expect(seen.size).toBe(600);
  expect(result.link).toEqual(current.links.at(-1)!);
  expect(current.controls).toHaveLength(256);
  expect(current.controls![0]!.signature).toBe('private-local-signature-0');
});

test('oversized research choices preserve verbatim evidence and reject invented group winners', async () => {
  const criteria = { none: 'No suitable evidence.', ...Object.fromEntries(Array.from({ length: 60 }, (_, i) =>
    [`passage_${i}`, `${i}: ${'근거 문장입니다. '.repeat(80)}`])) };
  const questions = { evidence: { type: 'choice' as const, instructions: 'Select evidence or none.', criteria } };
  const input = { page: page('research'), goal: 'Research', visited: [], signal: new AbortController().signal };
  const seen = new Set<string>();
  const answers = await evaluateAutopilotQuestions('fixture-key', input, questions, async (_url, init) => {
    expect(Buffer.byteLength(String(init.body))).toBeLessThanOrEqual(AUTOPILOT_REQUEST_BYTES);
    const body = JSON.parse(String(init.body)) as { questions: Record<string, ChoiceQuestion> };
    return Response.json({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      for (const [key, text] of Object.entries(question.criteria)) {
        seen.add(key);
        expect(text).toBe(criteria[key as keyof typeof criteria]);
      }
      return [id, { type: 'choice', choice: options.at(-1), confidence: 0.9 }];
    })) });
  });
  expect(seen.size).toBe(61);
  expect(answers.evidence).toEqual({ type: 'choice', choice: 'passage_59', confidence: 0.9 });
  await rejection(evaluateAutopilotQuestions('fixture-key', input, questions, async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, ChoiceQuestion> };
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id =>
      [id, { type: 'choice', choice: 'invented', confidence: 1 }])) });
  }), 'invalid choice');
});

test('stopping a split request prevents later batches and an unsplittable choice fails before sending', async () => {
  const controller = new AbortController();
  const input = { page: page('large'), goal: 'Target', visited: [], signal: controller.signal };
  const criteria = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`option_${i}`, 'details '.repeat(500)]));
  const question = { type: 'choice' as const, instructions: 'Choose a target.', criteria };
  let calls = 0;
  await rejection(evaluateAutopilotQuestions('fixture-key', input, { target: question }, async () => {
    calls++; controller.abort(new Error('Stopped between batches'));
    return Response.json({ answers: {} });
  }), 'Stopped between batches');
  expect(calls).toBe(1);
  await rejection(evaluateAutopilotQuestions('fixture-key', { ...input, signal: new AbortController().signal },
    { target: { ...question, criteria: { huge: 'x'.repeat(AUTOPILOT_REQUEST_BYTES) } } }, async () => {
      calls++; return Response.json({ answers: {} });
    }), 'choice is too large');
  expect(calls).toBe(1);
});

test('each split choice retains none so an irrelevant batch never forces a menu selection', async () => {
  const criteria = { none: 'No useful target.', ...Object.fromEntries(Array.from({ length: 300 }, (_, i) =>
    [`menu_${i}`, 'Unrelated menu '.repeat(40)])) };
  const seen = new Set<string>();
  const answer = await evaluateAutopilotQuestions('fixture', { page: page('start'), goal: 'Find repository', visited: [],
    signal: new AbortController().signal }, { target: { type: 'choice', instructions: 'Choose a useful action or none.', criteria } }, async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, ChoiceQuestion> };
    return Response.json({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      expect(question.criteria.none).toBe('No useful target.');
      for (const key of Object.keys(question.criteria)) if (key !== 'none') seen.add(key);
      return [id, { type: 'choice', choice: 'none', confidence: 1 }];
    })) });
  });
  expect(seen.size).toBe(300);
  expect(answer.target).toEqual({ type: 'choice', choice: 'none', confidence: 1 });
});

test('model recognizes arrival without links and rejects choices outside the supplied candidates', async () => {
  const current = page('target');
  const input = { page: current, goal: 'target', visited: [current.url], signal: new AbortController().signal };
  const response = (choice: string) => (async () => Response.json({ answers: {
    completion: { type: 'choice', choice, confidence: 0.9 },
  } }));
  expect((await createAutopilotModel('fixture-key', response('reached'))(input)).completed).toBe(true);
  expect((await createAutopilotModel('fixture-key', response('continue'))(input)).link).toBeNull();
  await rejection(createAutopilotModel('fixture-key', response('invented'))(input), 'invalid choice');
  const unauthorized = (async () => new Response('private upstream content', { status: 401 }));
  await rejection(createAutopilotModel('fixture-key', unauthorized)(input), 'rejected the API key');
});

function runnerHarness(decide?: Parameters<typeof createAutopilotRunner>[0]['decide'],
  follow?: Parameters<typeof createAutopilotRunner>[0]['follow']) {
  const loads: string[] = [];
  const follows: string[] = [];
  let configured = true;
  let cancelled = 0;
  const runner = createAutopilotRunner({ configured: () => configured, onState() {},
    load: async url => { loads.push(url); return page('start', ['target']); },
    follow: follow ?? (async (_page, link) => { follows.push(link.url); return page('target'); }),
    cancelLoad: () => { cancelled += 1; },
    decide: decide ?? (async ({ page }) => ({ completed: page.title === 'target', link: page.links[0] ?? null, confidence: 0.9 })),
  });
  return { runner, loads, follows, setConfigured: (value: boolean) => { configured = value; }, cancelled: () => cancelled };
}

test('runner loads the start page, follows a real link, records timing and finishes at the target', async () => {
  const h = runnerHarness();
  expect(h.runner.start({ url: 'https://example.org/start', goal: 'target' }).phase).toBe('loading');
  await flush();
  const result = h.runner.snapshot();
  expect(result.phase).toBe('completed');
  expect(result.steps.map(step => step.title)).toEqual(['start', 'target']);
  expect(result.modelMs).toBeGreaterThanOrEqual(result.steps[1]!.decisionMs);
  expect(h.follows).toEqual(['https://example.org/target']);
  result.steps.length = 0;
  expect(h.runner.snapshot().steps).toHaveLength(2);
  h.runner.dispose();
});

test('stop followed by restart ignores a late model reply from the previous run', async () => {
  const gate = createDeferred<AutopilotDecision>();
  let calls = 0;
  const h = runnerHarness(async () => ++calls === 1 ? gate.promise : { completed: true, link: null, confidence: 1 });
  h.runner.start({ url: 'https://example.org/start', goal: 'first' });
  await flush();
  expect(() => h.runner.start({ url: 'https://example.org/start', goal: 'duplicate' })).toThrow('Stop');
  expect(h.runner.stop().phase).toBe('stopped');
  h.runner.start({ url: 'https://example.org/start', goal: 'second' });
  await flush();
  gate.resolve({ completed: false, link: page('start', ['target']).links[0]!, confidence: 1 });
  await flush();
  expect(h.runner.snapshot().goal).toBe('second');
  expect(h.runner.snapshot().phase).toBe('completed');
  expect(h.follows).toEqual([]);
  h.runner.dispose();
});

test('missing keys and invalid model destinations never navigate', async () => {
  const h = runnerHarness(async () => ({ completed: false, link: { id: 'invented', url: 'https://elsewhere.org/', label: 'bad' }, confidence: 1 }));
  h.setConfigured(false);
  expect(() => h.runner.start({ url: 'https://example.org/start', goal: 'target' })).toThrow('Settings');
  expect(h.loads).toEqual([]);
  h.setConfigured(true);
  h.runner.start({ url: 'https://example.org/start', goal: 'target' });
  await flush();
  expect(h.runner.snapshot().phase).toBe('error');
  expect(h.follows).toEqual([]);
  h.runner.dispose();
});

test('navigation stops at the step limit and a pending page operation is abortable', async () => {
  let loaded = 0;
  const next = () => page(String(loaded++), [String(loaded)]);
  const runner = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {},
    load: async () => next(), follow: async () => next(),
    decide: async ({ page }) => ({ completed: false, link: page.links[0]!, confidence: 1 }),
  });
  runner.start({ url: 'https://example.org/0', goal: 'Never reached' });
  await flush();
  expect(runner.snapshot().phase).toBe('limit');
  expect(loaded).toBe(AUTOPILOT_MAX_STEPS + 1);
  runner.dispose();
  const controller = new AbortController();
  const operation = autopilotOperation(new Promise<void>(() => {}), controller.signal);
  controller.abort(new Error('Stopped'));
  await rejection(operation, 'Stopped');
});

test('page changes retry at most twice and do not duplicate the current journey entry', async () => {
  let attempts = 0;
  const h = runnerHarness(undefined, async current => {
    attempts += 1;
    throw new AutopilotPageChangedError({ ...current, title: `Refresh ${attempts}` });
  });
  h.runner.start({ url: 'https://example.org/start', goal: 'target' });
  await flush();
  const state = h.runner.snapshot();
  expect(attempts).toBe(3);
  expect(state.phase).toBe('error');
  expect(state.error).toContain('after 2 retries');
  expect(state.steps.map(step => step.title)).toEqual(['Refresh 2']);
  h.runner.dispose();
});

test('stop and restart during page refresh ignore a late change from the previous run', async () => {
  const refresh = createDeferred<AutopilotPage>();
  let decisions = 0;
  const h = runnerHarness(async ({ page }) => {
    decisions += 1;
    return { completed: decisions > 1, link: page.links[0] ?? null, confidence: 1 };
  }, async () => { throw new AutopilotPageChangedError(await refresh.promise); });
  h.runner.start({ url: 'https://example.org/start', goal: 'first' });
  await flush();
  expect(h.runner.snapshot().phase).toBe('loading');
  expect(h.runner.stop().phase).toBe('stopped');
  h.runner.start({ url: 'https://example.org/start', goal: 'second' });
  await flush();
  refresh.resolve(page('changed', ['target']));
  await flush();
  expect(decisions).toBe(2);
  expect(h.runner.snapshot().phase).toBe('completed');
  expect(h.runner.snapshot().goal).toBe('second');
  expect(h.runner.snapshot().steps.map(step => step.title)).toEqual(['start']);
  h.runner.dispose();
});

test('ordinary navigation errors do not trigger page-change retries', async () => {
  let attempts = 0;
  const h = runnerHarness(undefined, async () => {
    attempts += 1;
    throw new Error('Could not load this page');
  });
  h.runner.start({ url: 'https://example.org/start', goal: 'target' });
  await flush();
  expect(attempts).toBe(1);
  expect(h.runner.snapshot().error).toBe('Could not load this page');
  h.runner.dispose();
});

test('refreshed URLs retain loop protection and count toward the navigation limit', async () => {
  let follows = 0;
  const runner = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {},
    load: async () => page('0', ['target']),
    follow: async () => {
      const current = page(String(++follows), ['target']);
      if (follows % 2 === 1) throw new AutopilotPageChangedError(current);
      return current;
    },
    decide: async ({ page }) => ({ completed: false, link: page.links[0]!, confidence: 1 }),
  });
  runner.start({ url: 'https://example.org/0', goal: 'target' });
  await flush();
  expect(runner.snapshot().phase).toBe('limit');
  expect(follows).toBe(AUTOPILOT_MAX_STEPS);
  expect(runner.snapshot().steps).toHaveLength(AUTOPILOT_MAX_STEPS + 1);
  runner.dispose();

  const h = runnerHarness(undefined, async current => {
    throw new AutopilotPageChangedError(current.title === 'start' ? page('changed', ['target']) : page('start', ['target']));
  });
  h.runner.start({ url: 'https://example.org/start', goal: 'target' });
  await flush();
  expect(h.runner.snapshot().error).toContain('visited page');
  h.runner.dispose();
});
