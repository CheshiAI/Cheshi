import { expect, test } from 'bun:test';
import { createAutopilotRunner, AutopilotPageChangedError } from '../lib/autopilot-runner.mts';
import type { AutopilotRunnerOptions } from '../lib/autopilot-runner.mts';
import { researchPagePassages } from '../lib/autopilot-evidence.mts';
import { createAutopilotModel } from '../lib/autopilot-model.mts';
import type { AutopilotPage, AutopilotDecision } from '../lib/autopilot-model.mts';
import { parseAutopilotRequest, parseAutopilotState } from '../shared/autopilot';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const passage = (name: string) => `Primary evidence about the research topic, published on source ${name}.`;
const page = (name: string, links: string[] = []): AutopilotPage => ({ url: `https://example.org/${name}`, title: name,
  text: passage(name), links: links.map((name, index) => ({ id: `link_${index}`, label: name, url: `https://example.org/${name}` })) });
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(pages: Record<string, AutopilotPage>, overrides: Partial<AutopilotRunnerOptions> = {}) {
  const loads: string[] = [];
  const load = async (url: string) => {
    loads.push(url);
    const result = pages[url.split('/').at(-1)!];
    if (!result) throw new Error('Page unavailable');
    return result;
  };
  const choose: AutopilotRunnerOptions['decide'] = async ({ page: current }) => ({ completed: false,
    link: current.links[0] ?? null, confidence: 0.9,
    ...(current.title !== 'search' && current.text ? { evidence: { text: current.text, confidence: 0.85 } } : {}) });
  const runner = createAutopilotRunner({ configured: () => true, cancelLoad() {}, onState() {}, load,
    follow: async (_page, link) => load(link.url), decide: choose, ...overrides });
  return { runner, loads, start: (targetSources = 5) => runner.start({ url: page('search').url,
    goal: 'Research the topic', mode: 'research', targetSources }) };
}

test('collects sibling sources from a remembered result page and exports detached snapshots', async () => {
  const f = fixture({ search: page('search', ['a', 'b', 'c']), a: page('a'), b: page('b'), c: page('c') });
  try {
    f.start(3); await flush();
    const result = parseAutopilotState(f.runner.snapshot());
    expect(result.phase).toBe('completed');
    expect(result.sources?.map(source => source.title)).toEqual(['a', 'b', 'c']);
    expect(f.loads.map(url => url.split('/').at(-1))).toEqual(['search', 'a', 'b', 'c']);
    expect(result.sources?.every(source => Number.isFinite(Date.parse(source.accessedAt)))).toBe(true);
    result.sources![0]!.evidence = 'changed by caller';
    expect(f.runner.snapshot().sources![0]!.evidence).toBe(passage('a'));
  } finally { f.runner.dispose(); }
});

test('deduplicates sources after redirects and reports exhausted research as incomplete', async () => {
  const f = fixture({ search: page('search', ['a', 'alias']), a: page('a'), alias: page('a') });
  try {
    f.start(3); await flush();
    expect(f.runner.snapshot().sources).toHaveLength(1);
    expect(f.runner.snapshot().phase).toBe('partial');
    expect(f.runner.snapshot().error).toContain('No more');
  } finally { f.runner.dispose(); }
});

test('keeps searching after a page fails and preserves the failed URL with successful sources', async () => {
  const f = fixture({ search: page('search', ['missing', 'a', 'b']), a: page('a'), b: page('b') });
  try {
    f.start(2); await flush();
    const result = parseAutopilotState(f.runner.snapshot());
    expect(result.phase).toBe('completed');
    expect(result.sources).toHaveLength(2);
    expect(result.issues).toEqual([{ url: page('missing').url, message: 'Could not load or read this source.' }]);
  } finally { f.runner.dispose(); }
});

test('an unavailable starting page produces an exportable issue', async () => {
  const f = fixture({});
  try {
    f.start(); await flush();
    expect(f.runner.snapshot().phase).toBe('partial');
    expect(f.runner.snapshot().issues?.[0]?.url).toBe(page('search').url);
  } finally { f.runner.dispose(); }
});

test('rejects fabricated evidence and invented navigation destinations', async () => {
  for (const decision of [
    { completed: false, confidence: 1, link: null, evidence: { text: 'fabricated', confidence: 1 } },
    { completed: false, confidence: 1, link: { id: 'invented', label: 'Bad', url: 'https://other.test/' } },
  ]) {
    const f = fixture({ search: page('search', ['a']), a: page('a') }, { decide: async () => decision });
    try {
      f.start(); await flush();
      expect(f.runner.snapshot().phase).toBe('error');
      expect(f.runner.snapshot().sources).toHaveLength(0);
      expect(f.loads).toHaveLength(1);
    } finally { f.runner.dispose(); }
  }
});

test('rechecks changed evidence before saving and never saves the obsolete passage', async () => {
  const original = page('a');
  const updated = { ...original, text: passage('updated') };
  const f = fixture({ search: original }, { read: async () => updated });
  try {
    f.start(1); await flush();
    expect(f.runner.snapshot().phase).toBe('completed');
    expect(f.runner.snapshot().sources?.[0]?.evidence).toBe(updated.text);
  } finally { f.runner.dispose(); }
});

test('repeated evidence changes terminate with partial results instead of looping', async () => {
  let revision = 0;
  const f = fixture({ search: page('a') }, { read: async () => ({ ...page('a'), text: passage(String(++revision)) }) });
  try {
    f.start(); await flush();
    expect(revision).toBe(3);
    expect(f.runner.snapshot().phase).toBe('partial');
    expect(f.runner.snapshot().sources).toHaveLength(0);
  } finally { f.runner.dispose(); }
});

test('refreshes a stale action and bounds repeated page changes', async () => {
  let attempts = 0;
  const f = fixture({ search: page('search', ['a']) }, { follow: async () => {
    attempts++; throw new AutopilotPageChangedError(page('search', ['a']));
  } });
  try {
    f.start(); await flush();
    expect(attempts).toBe(3);
    expect(f.runner.snapshot().phase).toBe('partial');
  } finally { f.runner.dispose(); }
});

test('bounds an endless research path at 20 actions', async () => {
  const pages = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [String(index), page(String(index), [String(index + 1)])]));
  const f = fixture({ search: page('search', ['0']), ...pages }, { decide: async ({ page }) => ({ completed: false,
    confidence: 1, link: page.links[0] ?? null }) });
  try {
    f.start(); await flush();
    expect(f.runner.snapshot().phase).toBe('partial');
    expect(f.runner.snapshot().steps).toHaveLength(21);
    expect(f.loads).toHaveLength(21);
  } finally { f.runner.dispose(); }
});

test('stop preserves collected evidence and a late decision cannot pollute a restarted run', async () => {
  const pending = createDeferred<AutopilotDecision>();
  const waiting = createDeferred<void>();
  const f = fixture({ search: page('search', ['a', 'b']), a: page('a'), b: page('b') }, {
    decide: async ({ page: current }) => {
      if (current.title === 'b') { waiting.resolve(); return pending.promise; }
      return { completed: false, confidence: 1, link: current.links[0] ?? null,
        ...(current.title === 'a' ? { evidence: { text: current.text, confidence: 1 } } : {}) };
    },
  });
  try {
    f.start(); await waiting.promise;
    expect(f.runner.stop().sources).toHaveLength(1);
    expect(f.runner.snapshot().phase).toBe('stopped');
    f.runner.start({ url: page('search').url, goal: 'Navigate' });
    pending.resolve({ completed: false, confidence: 1, link: null, evidence: { text: passage('b'), confidence: 1 } });
    await flush();
    expect(f.runner.snapshot().mode).toBeUndefined();
    expect(f.runner.snapshot().sources).toBeUndefined();
  } finally { f.runner.dispose(); }
});

test('model failure retains already collected sources', async () => {
  const f = fixture({ search: page('a', ['b']), b: page('b') }, { decide: async ({ page: current }) => {
    if (current.title === 'b') throw new Error('Model unavailable');
    return { completed: false, confidence: 1, link: current.links[0]!, evidence: { text: current.text, confidence: 1 } };
  } });
  try {
    f.start(2); await flush();
    expect(f.runner.snapshot().phase).toBe('error');
    expect(f.runner.snapshot().sources).toHaveLength(1);
  } finally { f.runner.dispose(); }
});

test('research supports search input and stops after an unconfirmed click', async () => {
  const control = { id: 'control_1', kind: 'button' as const, label: 'Search', signature: 'button', value: '' };
  let attempts = 0;
  const f = fixture({ search: { ...page('search'), controls: [control] } }, {
    decide: async () => ({ completed: false, confidence: 1, link: null, interaction: { kind: 'click', control } }),
    interact: async () => { attempts++; throw new Error('Click unconfirmed'); },
  });
  try {
    f.runner.start({ url: page('search').url, goal: 'Research', mode: 'research', searchText: 'topic' }); await flush();
    expect(attempts).toBe(1);
    expect(f.runner.snapshot().phase).toBe('partial');
    expect(f.runner.snapshot().issues).toHaveLength(1);
  } finally { f.runner.dispose(); }
});

test('Jev receives actual evidence candidates and cannot return an invented passage ID', async () => {
  for (const selected of ['passage_0', 'none', 'invented']) {
    const model = createAutopilotModel('fixture-key', async (_url, options) => {
      const body = JSON.parse(String(options.body));
      expect(body.questions.completion).toBeUndefined();
      expect(body.questions.evidence.criteria.passage_0).toBe(passage('a'));
      return Response.json({ answers: { evidence: { type: 'choice', choice: selected, confidence: 0.8 } } });
    });
    let result: AutopilotDecision | undefined;
    let error: unknown;
    try { result = await model({ page: page('a'), goal: 'Research', visited: [], research: true, signal: new AbortController().signal }); }
    catch (cause) { error = cause; }
    if (selected === 'invented') expect(error).toBeInstanceOf(Error);
    else if (selected === 'none') expect(result?.evidence).toBeUndefined();
    else expect(result?.evidence).toEqual({ text: passage('a'), confidence: 0.8 });
  }
});

test('research contracts validate source targets and untrusted result fields', () => {
  expect(parseAutopilotRequest({ url: page('search').url, goal: 'Research', mode: 'research' }).targetSources).toBe(5);
  for (const targetSources of [0, 11, 1.5, '5', null]) {
    expect(() => parseAutopilotRequest({ url: page('search').url, goal: 'Research', mode: 'research', targetSources })).toThrow();
  }
  const result = { configured: true, phase: 'partial', url: page('a').url, title: 'a', goal: 'Research', error: null,
    steps: [], modelMs: 0, mode: 'research', targetSources: 5, issues: [], sources: [{ url: page('a').url,
      title: 'a', evidence: passage('a'), accessedAt: new Date().toISOString(), confidence: 0.8 }] };
  expect(parseAutopilotState(result).sources).toHaveLength(1);
  for (const override of [{ url: 'javascript:alert(1)' }, { accessedAt: 'invalid' }, { confidence: 2 }, { evidence: '' }]) {
    expect(() => parseAutopilotState({ ...result, sources: [{ ...result.sources[0], ...override }] })).toThrow();
  }
  expect(() => parseAutopilotState({ ...result, sources: [result.sources[0], result.sources[0]] })).toThrow();
});


test('research blocks repeat clicks despite changed DOM identity and resets the guard on a fresh run', async () => {
  let count = 0;
  const control = { id: 'control_1', kind: 'button' as const, label: 'Input tools', value: '', signature: 'closed' };
  const initial = { ...page('search'), controls: [control] };
  const runner = createAutopilotRunner({ configured: () => true, onState() {}, cancelLoad() {}, load: async () => initial,
    follow: async () => initial,
    interact: async current => { count++; return { ...current, controls: [{ ...control, id: 'control_2', signature: 'open' }] }; },
    decide: async ({ page: current, completedInteractions }) => {
      if (current.controls![0]!.id === 'control_2') expect(completedInteractions).toHaveLength(1);
      return { link: null, completed: false, confidence: 1, interaction: { kind: 'click', control: current.controls![0]! } };
    },
  });
  try {
    const request = { url: initial.url, goal: 'Research', mode: 'research' as const, targetSources: 3, searchText: 'Jev' };
    runner.start(request); await flush();
    expect(count).toBe(1);
    expect(runner.snapshot().phase).toBe('error');
    runner.start(request); await flush();
    expect(count).toBe(2);
  } finally { runner.dispose(); }
});


test('Google result snippets are unavailable as model evidence while navigation remains available', async () => {
  const original = page('original');
  const results = { ...page('search', ['original']), url: 'https://www.google.com/search?q=TypeSafe+AI+Jev' };
  const model = createAutopilotModel('fixture', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body.questions.evidence.criteria)).toEqual(['none']);
    return Response.json({ answers: { evidence: { type: 'choice', choice: 'none', confidence: 1 },
      links_0: { type: 'choice', choice: 'link_0', confidence: 1 } } });
  });
  const decision = await model({ page: results, research: true, goal: 'Find sources', visited: [], signal: new AbortController().signal });
  expect(decision.evidence).toBeUndefined();
  expect(decision.link?.url).toBe(original.url);
  for (const url of ['https://google.co.kr/search?q=Jev', 'https://google.com/webhp?q=Jev', 'https://www.google.co.uk/?q=Jev']) {
    expect(researchPagePassages({ ...results, url })).toEqual({});
  }
  expect(Object.keys(researchPagePassages({ ...results, url: 'https://example.org/search?q=Jev' }))).not.toHaveLength(0);
  expect(Object.keys(researchPagePassages({ ...results, url: 'https://google.com.example.org/search?q=Jev' }))).not.toHaveLength(0);
});

test('research runtime rejects a Google snippet even if a decision incorrectly marks it as evidence', async () => {
  const results = { ...page('search'), url: 'https://www.google.com/search?q=Jev' };
  const runner = createAutopilotRunner({ configured: () => true, cancelLoad() {}, onState() {},
    load: async () => results, follow: async () => results,
    decide: async () => ({ completed: false, link: null, confidence: 1, evidence: { text: results.text, confidence: 1 } }),
  });
  try {
    runner.start({ url: results.url, goal: 'Jev sources', mode: 'research' }); await flush();
    expect(runner.snapshot().sources).toHaveLength(0);
    expect(runner.snapshot().phase).toBe('error');
    expect(runner.snapshot().error).toContain('not a passage');
  } finally { runner.dispose(); }
});
