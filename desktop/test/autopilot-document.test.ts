import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createContext, runInContext } from 'node:vm';
import { AUTOPILOT_PAGE_SCRIPT, autopilotSectionScript, parseAutopilotPage } from '../lib/autopilot-page.mts';
import { researchPagePassages, researchPassages } from '../lib/autopilot-evidence.mts';
import { createAutopilotModel } from '../lib/autopilot-model.mts';
import type { AutopilotPage } from '../lib/autopilot-model.mts';
import { AutopilotPageChangedError, createAutopilotRunner } from '../lib/autopilot-runner.mts';
import type { AutopilotRunnerOptions } from '../lib/autopilot-runner.mts';
import type { ResearchSession } from '../lib/autopilot-codex.mts';
import type { ResearchPlan } from '../shared/autopilot-investigation.ts';
import { autopilotReport } from '../lib/autopilot-report.mts';
import { parseAutopilotState } from '../shared/autopilot.ts';

function documentFixture(markup: string) {
  const window = new Window({ url: 'https://example.org/reference' });
  window.document.body.innerHTML = markup;
  window.HTMLElement.prototype.getClientRects = function (this: InstanceType<typeof window.HTMLElement>) {
    return this.style.display === 'none' ? [] : [{ width: 100, height: 20 }];
  } as typeof window.HTMLElement.prototype.getClientRects;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const context = createContext({ document: window.document, location: window.location, URL,
    getComputedStyle: window.getComputedStyle.bind(window) });
  const read = (code = AUTOPILOT_PAGE_SCRIPT) => parseAutopilotPage(runInContext(code, context));
  return { window, read, close: () => window.happyDOM.close() };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('reads a schema after 12,000 characters through its heading without returning full bodies in the outline', async () => {
  const h = documentFixture(`<main><h1>Introduction</h1><p>${'Background material. '.repeat(1000)}</p>
    <h2>Error response</h2><pre>error.code: string\nerror.message: string\nrequired: true</pre></main>`);
  try {
    const initial = h.read();
    expect(initial.text).not.toContain('error.code');
    const section = initial.sections!.find(section => section.title === 'Error response')!;
    expect(section.kind).toBe('code');
    expect('text' in section).toBe(false);
    const selected = h.read(autopilotSectionScript(initial, section));
    expect(selected.text).toContain('error.code: string');
    expect(selected.section?.title).toBe('Error response');
    expect(Object.values(researchPagePassages(selected)).join('\n')).toContain('error.message: string');
  } finally { await h.close(); }
});

test('preserves long paragraph tails, table cells and short fields while excluding hidden content', async () => {
  const h = documentFixture(`<main><h2>Limits</h2><p>${'Long paragraph '.repeat(700)}TAIL_MARKER</p>
    <h2>Fields</h2><table><tr><th>name</th><th>type</th></tr><tr><td>state</td><td>object</td></tr></table>
    <p hidden>Hidden secret</p><nav>Navigation noise</nav><p aria-hidden="true">Invisible data</p></main>`);
  try {
    const page = h.read();
    const bodies = page.sections!.map(section => h.read(autopilotSectionScript(page, section)));
    expect(bodies.some(body => body.text.includes('TAIL_MARKER'))).toBe(true);
    expect(bodies.some(body => body.section?.kind === 'table' && body.text.includes('state'))).toBe(true);
    expect(bodies.every(body => !/Hidden secret|Navigation noise|Invisible data/.test(body.text))).toBe(true);
    const candidates = Object.values(researchPassages('Long paragraph '.repeat(200) + 'TAIL_MARKER'));
    expect(candidates.some(text => text.includes('TAIL_MARKER'))).toBe(true);
    expect(candidates.every(text => text.length <= 1200)).toBe(true);
    expect(Object.values(researchPassages('code\nmessage\nrequired: true')).join('\n')).toContain('required: true');
  } finally { await h.close(); }
});

test('a changed document rejects a stale section and excessive documents report their limit', async () => {
  const h = documentFixture('<main><h2>Schema</h2><pre>old: true</pre></main>');
  try {
    const before = h.read();
    h.window.document.querySelector('pre')!.textContent = 'new: true';
    const stale = h.read(autopilotSectionScript(before, before.sections![0]!));
    expect(stale.section).toBeUndefined();
    expect(stale.documentVersion).not.toBe(before.documentVersion);
    h.window.document.querySelector('main')!.innerHTML = '<p>' + 'x'.repeat(800_000) + '</p>';
    const large = h.read();
    expect(large.sections).toHaveLength(128);
    expect(large.documentTruncated).toBe(true);
  } finally { await h.close(); }
});

test('Jev chooses only unread document sections and receives previously collected evidence', async () => {
  const section = { id: 'section_1', title: 'Response schema', kind: 'code' as const, preview: 'error.code' };
  const model = createAutopilotModel('fixture', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body.state.collectedEvidence).toEqual(['Already collected']);
    expect(body.questions.reading.criteria).not.toHaveProperty('section_0');
    return Response.json({ answers: { evidence: { type: 'choice', choice: 'none', confidence: 1 },
      reading: { type: 'choice', choice: section.id, confidence: 1 } } });
  });
  const result = await model({ page: { url: 'https://example.org/', title: 'Docs', text: '', links: [],
    sections: [{ ...section, id: 'section_0' }, section] }, goal: 'Explain schema', question: plan.questions[0],
    research: true, readSections: ['section_0'], collectedEvidence: ['Already collected'], visited: [], signal: new AbortController().signal });
  expect(result.section).toEqual(section);
});

const plan: ResearchPlan = { officialDomains: ['example.org'], questions: [{ id: 'q1', question: 'What are all required fields?',
  query: 'schema', externalQuery: 'schema details', requireIndependent: false, requireOfficial: true }] };
const section = { id: 'section_0', title: 'Response schema', kind: 'text' as const, preview: 'code and message' };
const first = 'The code field is a required string identifying the response error.';
const second = 'The message field is a required string explaining the response error.';
const initial: AutopilotPage = { url: 'https://example.org/reference', title: 'Docs', text: 'Introduction', links: [], sections: [section], documentVersion: 'abc' };
const selected: AutopilotPage = { ...initial, section, text: `${first}\n${second}` };

test('code and table evidence keeps neighboring long lines together', () => {
  for (const kind of ['code', 'table'] as const) {
    const passages = Object.values(researchPagePassages({ ...selected, section: { ...section, kind } }));
    expect(passages).toEqual([`${first}\n${second}`]);
  }
});
function runnerFixture(overrides: Partial<AutopilotRunnerOptions> = {}) {
  let reads = 0;
  const session: ResearchSession = { model: 'selected', plan: async () => plan, close() {}, report: async (_goal, _plan, sources) => ({ answers: [{
    questionId: 'q1', status: sources.length === 2 ? 'answered' : 'unconfirmed', answer: 'Fields from the reference.', sourceIds: sources.map(source => source.id!),
    comparison: 'Official reference.', limitations: 'Only collected sections were inspected.',
  }] }) };
  const runner = createAutopilotRunner({ configured: () => true, cancelLoad() {}, onState() {}, research: { open: async () => session },
    load: async () => initial, follow: async () => initial, read: async (_signal, page) => page ?? initial,
    readSection: async () => { reads++; return selected; },
    decide: async ({ page, collectedEvidence }) => !page.section
      ? { section, link: null, completed: false, confidence: 1 }
      : { link: null, completed: false, confidence: 1, evidence: { text: collectedEvidence?.includes(first) ? second : first, confidence: 1 },
        assessment: { role: 'official', relation: 'supports', sufficient: collectedEvidence?.includes(first) === true } }, ...overrides });
  return { runner, reads: () => reads, start: () => runner.start({ url: initial.url, goal: 'Fields', mode: 'research', targetSources: 5 }) };
}

test('collects multiple passages from one section and preserves the section in UI state and exports', async () => {
  const f = runnerFixture();
  try {
    f.start(); await flush();
    const state = parseAutopilotState(f.runner.snapshot());
    expect(state.phase).toBe('completed');
    expect(state.sources).toHaveLength(2);
    expect(f.reads()).toBe(1);
    expect(state.sources?.every(source => source.section === 'Response schema')).toBe(true);
    expect(state.steps.some(step => step.action?.startsWith('Read section:'))).toBe(true);
    expect(autopilotReport(state, 'markdown')).toContain('Section: Response schema');
    expect(autopilotReport(state, 'csv')).toContain('"Response schema","section_0"');
  } finally { f.runner.dispose(); }
});

test('repeated and invented section choices cannot create unbounded reads', async () => {
  for (const id of ['section_0', 'section_99']) {
    const f = runnerFixture({ decide: async () => ({ section: { ...section, id }, link: null, completed: false, confidence: 1 }) });
    try {
      f.start(); await flush();
      expect(f.reads()).toBe(id === 'section_0' ? 1 : 0);
      expect(f.runner.snapshot().issues?.[0]?.message).toContain('unavailable or already read');
    } finally { f.runner.dispose(); }
  }
});

test('a changed revision allows the same section to be read again before collecting evidence', async () => {
  let changed = false, reads = 0;
  const f = runnerFixture({
    readSection: async page => { reads++; return { ...selected, documentVersion: page.documentVersion }; },
    read: async (_signal, page) => {
      if (!changed) { changed = true; throw new AutopilotPageChangedError({ ...initial, documentVersion: 'def' }); }
      return page!;
    },
  });
  try {
    f.start(); await flush();
    const state = f.runner.snapshot();
    expect(reads).toBe(2);
    expect(state.phase).toBe('completed');
    expect(state.sources).toHaveLength(2);
    expect(state.issues).toEqual([]);
  } finally { f.runner.dispose(); }
});

test('stopping a pending section read prevents a late read from changing a restarted run', async () => {
  const pending = deferred<AutopilotPage>();
  const f = runnerFixture({ readSection: async () => pending.promise });
  try {
    f.start(); await flush();
    expect(f.runner.snapshot().phase).toBe('reading');
    expect(f.runner.stop().phase).toBe('stopped');
    f.runner.start({ url: initial.url, goal: 'Navigate' });
    pending.resolve(selected); await flush();
    expect(f.runner.snapshot().sources).toBeUndefined();
    expect(f.runner.snapshot().steps.some(step => step.action?.startsWith('Read section:'))).toBe(false);
  } finally { f.runner.dispose(); }
});
