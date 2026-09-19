import { expect, test } from 'bun:test';
import { createAutopilotRunner } from '../lib/autopilot-runner.mts';
import type { AutopilotRunnerOptions } from '../lib/autopilot-runner.mts';
import type { ResearchSession } from '../lib/autopilot-codex.mts';
import { createAutopilotCodex } from '../lib/autopilot-codex.mts';
import { parseResearchPlan, parseResearchReport, questionStatus, researchPublisher } from '../shared/autopilot-investigation.ts';
import type { ResearchPlan, ResearchReport, ResearchAssessment } from '../shared/autopilot-investigation.ts';
import { parseAutopilotState } from '../shared/autopilot.ts';
import { autopilotReport } from '../lib/autopilot-report.mts';
import { createAutopilotModel } from '../lib/autopilot-model.mts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const plan: ResearchPlan = { officialDomains: ['example.org', 'example.ai'], questions: [
  { id: 'q1', question: 'What does the product do?', query: 'product functions', externalQuery: 'product functions review', requireIndependent: false },
  { id: 'q2', question: 'Does it work reliably?', query: 'product reliability', externalQuery: 'product independent reliability tests', requireIndependent: true },
] };
const quote = 'This is substantive evidence describing the product capabilities and test results.';
function report(plan: ResearchPlan, evidence: ResearchAssessment[]): ResearchReport {
  return { answers: plan.questions.map(q => ({ questionId: q.id, status: questionStatus(q, evidence), answer: 'Findings from the collected evidence.',
    sourceIds: evidence.filter(e => e.questionId === q.id).map(e => e.sourceId), comparison: 'Publisher claims compared with independent evidence.',
    limitations: 'Only these passages were checked.' })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
async function rejected(operation: Promise<unknown>, message: string) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
}
function fixture(overrides: Partial<AutopilotRunnerOptions> = {}, sessionOverrides: Partial<ResearchSession> = {}) {
  const urls: string[] = [];
  let closed = 0;
  const session: ResearchSession = { model: 'selected-model', plan: async () => plan,
    report: async (_goal, plan, _sources, assessments) => report(plan, assessments), close: () => { closed++; }, ...sessionOverrides };
  const runner = createAutopilotRunner({ configured: () => true, cancelLoad() {}, onState() {},
    research: { open: async () => session },
    load: async url => {
      urls.push(url);
      const query = new URL(url).searchParams.get('q') ?? '';
      return { url, title: 'Search', text: '', links: [{ id: 'a', url: query.includes('independent') ? 'https://review.test/test' : 'https://example.org/info', label: 'Source' }] };
    },
    follow: async (_page, link) => ({ url: link.url, title: 'Source', text: quote, links: [] }),
    decide: async ({ page }) => ({ completed: false, confidence: 1, link: page.links[0] ?? null,
      ...(page.text ? { evidence: { text: page.text, confidence: 1 }, assessment: { role: 'external', relation: 'supports', sufficient: true } } : {}) }),
    ...overrides,
  });
  return { runner, urls, closed: () => closed, start: (targetSources = 10) => runner.start({ url: 'https://www.google.com/', goal: 'Research product', mode: 'research', targetSources }) };
}

test('fills question gaps with independent searches, reuses source IDs, and stops before the source limit', async () => {
  const f = fixture();
  try {
    f.start(); await flush();
    const state = parseAutopilotState(f.runner.snapshot());
    expect(state.phase).toBe('completed');
    expect(state.sources).toHaveLength(2);
    expect(f.urls.some(url => decodeURIComponent(url).includes('independent'))).toBe(true);
    expect(state.investigation?.assessments.filter(e => e.sourceId === 's1').map(e => e.role)).toEqual(['official', 'official']);
    expect(state.investigation?.report?.answers).toHaveLength(2);
    expect(f.closed()).toBe(1);
    expect(autopilotReport(state, 'markdown')).toContain('[s2](https://review.test/test)');
    expect(autopilotReport(state, 'csv')).toContain('"assessment"');
    state.investigation!.plan.questions[0]!.question = 'mutated';
    expect(f.runner.snapshot().investigation!.plan.questions[0]!.question).toBe(plan.questions[0]!.question);
  } finally { f.runner.dispose(); }
});

test('source limit yields a partial report and does not claim missing questions are answered', async () => {
  const f = fixture();
  try {
    f.start(1); await flush();
    const state = f.runner.snapshot();
    expect(state.phase).toBe('partial');
    expect(state.investigation?.report?.answers).toHaveLength(2);
    expect(questionStatus(plan.questions[1]!, state.investigation!.assessments)).toBe('unconfirmed');
  } finally { f.runner.dispose(); }
});

test('conflicting evidence stays conflicting in the report and requires a citation', async () => {
  const assessments: ResearchAssessment[] = [
    { questionId: 'q1', sourceId: 's1', role: 'official', relation: 'supports', sufficient: true },
    { questionId: 'q1', sourceId: 's2', role: 'external', relation: 'challenges', sufficient: true },
  ];
  expect(questionStatus(plan.questions[0]!, assessments)).toBe('conflicting');
  const result = report(plan, assessments);
  result.answers[0]!.sourceIds = ['s1'];
  expect(() => parseResearchReport(result, plan, assessments)).toThrow('conflicting evidence');
  result.answers[0]!.sourceIds = ['s3'];
  expect(() => parseResearchReport(result, plan, assessments)).toThrow('not collected');
});

test('rejects missing question answers, missing citations, raw invented URLs and truthy flags', () => {
  const evidence: ResearchAssessment[] = [{ questionId: 'q1', sourceId: 's1', role: 'official', relation: 'supports', sufficient: true }];
  const result = report(plan, evidence);
  expect(() => parseResearchReport({ answers: [] }, plan, evidence)).toThrow('every research question');
  result.answers[0]!.sourceIds = [];
  expect(() => parseResearchReport(result, plan, evidence)).toThrow('missing citations');
  result.answers[0]!.sourceIds = ['s1']; result.answers[0]!.answer = 'See https://invented.test';
  expect(() => parseResearchReport(result, plan, evidence)).toThrow('structured citations');
  expect(() => parseResearchPlan({ ...plan, questions: [{ ...plan.questions[0], requireIndependent: 'true' }] })).toThrow();
  expect(researchPublisher('https://docs.example.ai/x', plan.officialDomains)).toBe('official');
  expect(researchPublisher('https://news.review.test/x', plan.officialDomains)).toBe('review.test');
});

test('stop during synthesis preserves evidence and ignores a late report after restart', async () => {
  const pending = deferred<ResearchReport>();
  const f = fixture({}, { report: async () => pending.promise });
  try {
    f.start(); await flush();
    expect(f.runner.snapshot().phase).toBe('synthesizing');
    const before = f.runner.stop();
    expect(before.sources).toHaveLength(2);
    expect(autopilotReport(before, 'markdown')).toContain('No final answer');
    f.runner.start({ url: 'https://example.org/', goal: 'Navigate' });
    pending.resolve(report(plan, [])); await flush();
    expect(f.runner.snapshot().investigation).toBeUndefined();
    expect(f.closed()).toBe(1);
  } finally { f.runner.dispose(); }
});

test('planning failure closes the lease and exposes no fabricated findings', async () => {
  const f = fixture({}, { plan: async () => { throw new Error('Codex unavailable'); } });
  try {
    f.start(); await flush();
    expect(f.runner.snapshot().error).toBe('Codex unavailable');
    expect(f.runner.snapshot().sources).toEqual([]);
    expect(f.closed()).toBe(1);
  } finally { f.runner.dispose(); }
});

test('empty searches exhaust attempts and still produce an exportable report with unconfirmed questions', async () => {
  const f = fixture({ load: async url => ({ url, title: 'No results', text: '', links: [] }) });
  try {
    f.start(); await flush();
    const state = parseAutopilotState(f.runner.snapshot());
    expect(state.phase).toBe('partial');
    expect(state.steps).toHaveLength(4);
    expect(state.sources).toHaveLength(0);
    expect(state.investigation!.report!.answers.every(answer => answer.answer.includes('Unconfirmed'))).toBe(true);
    expect(autopilotReport(state, 'markdown')).toContain('Unconfirmed');
  } finally { f.runner.dispose(); }
});

test('questions share observed source snapshots and do not revisit an unhelpful source on each query attempt', async () => {
  let visits = 0, decisionsWithHistory = 0;
  const f = fixture({
    follow: async (_current, link) => { visits++; return { url: link.url, title: 'Source', text: 'Not relevant', links: [] }; },
    decide: async input => {
      if (input.history?.length) decisionsWithHistory++;
      return { link: input.page.links[0] ?? null, completed: false, confidence: 1 };
    },
    load: async url => ({ url, title: 'Search', text: '', links: [{ id: 'a', url: 'https://example.org/same', label: 'Source' }] }),
  });
  try {
    f.start(); await flush();
    expect(visits).toBe(1);
    expect(decisionsWithHistory).toBeGreaterThan(0);
    expect(f.runner.snapshot().steps.some(step => step.action?.startsWith('Reuse observed page'))).toBe(true);
    expect(f.runner.snapshot().phase).toBe('partial');
  } finally { f.runner.dispose(); }
});

test('a dispatched but unconfirmed click is blocked across research questions and attempts', async () => {
  let clicks = 0;
  const button = { id: 'control_1', kind: 'button' as const, label: 'Search', value: '', signature: 'search', identity: 'search' };
  const f = fixture({
    load: async () => ({ url: 'https://example.org/search', title: 'Search', text: '', links: [], controls: [button] }),
    interact: async (_page, _action, _signal, dispatched) => { dispatched?.(); clicks++; throw new Error('Lost response'); },
    decide: async ({ completedInteractions, outcomes }) => {
      if (completedInteractions?.length) {
        expect(outcomes?.[0]?.status).toBe('unconfirmed');
        return { link: null, completed: false, confidence: 1 };
      }
      return { link: null, interaction: { kind: 'click', control: button }, completed: false, confidence: 1 };
    },
  });
  try {
    f.start(); await flush();
    expect(clicks).toBe(1);
    expect(f.runner.snapshot().phase).toBe('partial');
  } finally { f.runner.dispose(); }
});

test('synthesis failure preserves evidence and source mappings for export', async () => {
  const f = fixture({}, { report: async () => { throw new Error('Invalid citation'); } });
  try {
    f.start(); await flush();
    const state = parseAutopilotState(f.runner.snapshot());
    expect(state.phase).toBe('error');
    expect(state.sources).toHaveLength(2);
    expect(state.investigation?.report).toBeUndefined();
    expect(autopilotReport(state, 'markdown')).toContain('Invalid citation');
  } finally { f.runner.dispose(); }
});

test('all question searches share the 20 action limit and stale evidence is never stored', async () => {
  let sequence = 0;
  const pages = (url: string) => ({ url, title: 'Page', text: quote, links: [{ id: 'a', url: `https://external.test/${++sequence}`, label: 'Next' }] });
  const f = fixture({ load: async url => pages(url), follow: async (_page, link) => pages(link.url),
    decide: async ({ page }) => ({ completed: false, confidence: 1, link: page.links[0] ?? null }) }, {
    plan: async () => ({ ...plan, questions: [...plan.questions, ...plan.questions.map((q, index) => ({ ...q, id: `q${index + 3}`, question: q.question + ' more' }))] }),
  });
  try {
    f.start(); await flush();
    const state = parseAutopilotState(f.runner.snapshot());
    expect(state.steps).toHaveLength(21);
    expect(state.phase).toBe('partial');
  } finally { f.runner.dispose(); }
  const stale = fixture({ read: async () => ({ url: 'https://changed.test/', title: 'Changed', text: '', links: [] }) });
  try {
    stale.start(); await flush();
    expect(stale.runner.snapshot().sources).toHaveLength(0);
    expect(stale.runner.snapshot().phase).toBe('partial');
  } finally { stale.runner.dispose(); }
});

test('Codex uses the captured model and effort, validates citations with one retry and releases its busy lease', async () => {
  const calls: Array<{ model: string; effort: string; input: string }> = [];
  let index = 0;
  const evidence: ResearchAssessment[] = [{ questionId: 'q1', sourceId: 's1', role: 'official', relation: 'supports', sufficient: true }];
  const outputs = [plan, { answers: [] }, report(plan, evidence)];
  const bridge = createAutopilotCodex({ configuration: async id => { expect(id).toBe('active-pane'); return { model: 'chosen', effort: 'high' }; },
    session: () => ({ cancel() {}, run: async value => {
      calls.push(value as { model: string; effort: string; input: string });
      return { text: JSON.stringify(outputs[index++]), model: 'chosen' };
    } }) });
  const signal = new AbortController().signal;
  const session = await bridge.open('active-pane', signal);
  expect(bridge.busy).toBe(true);
  expect(await session.plan('Research', signal)).toEqual(plan);
  expect(await session.report('Research', plan, [], evidence, signal)).toEqual(parseResearchReport(report(plan, evidence), plan, evidence));
  expect(calls.every(call => call.model === 'chosen' && call.effort === 'high')).toBe(true);
  expect(calls.at(-1)?.input).toContain('correction');
  session.close(); session.close(); expect(bridge.busy).toBe(false);
});

test('cancellation reaches only its temporary Codex request and failed selection releases the lease', async () => {
  const pending = deferred<{ text: string; model: string }>();
  const canceled: string[] = [];
  const bridge = createAutopilotCodex({ configuration: async () => ({ model: 'chosen', effort: 'high' }),
    session: () => ({ run: async () => pending.promise, cancel(id) { canceled.push(id); pending.resolve({ text: '{}', model: 'chosen' }); } }) });
  const controller = new AbortController();
  const session = await bridge.open(undefined, controller.signal);
  const operation = session.plan('Research', controller.signal);
  controller.abort(new Error('Canceled'));
  await rejected(operation, 'Canceled');
  expect(canceled).toHaveLength(1); expect(canceled[0]).toStartWith('autopilot-');
  session.close(); expect(bridge.busy).toBe(false);
  const failed = createAutopilotCodex({ configuration: async () => { throw new Error('No model'); }, session: () => { throw new Error('Unexpected'); } });
  await rejected(failed.open(undefined, new AbortController().signal), 'No model');
  expect(failed.busy).toBe(false);
});

test('Jev assesses the exact selected passage with bounded roles and literal sufficiency', async () => {
  let calls = 0;
  const model = createAutopilotModel('fixture', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    calls++;
    if (calls === 1) return Response.json({ answers: { evidence: { type: 'choice', choice: 'passage_0', confidence: 1 } } });
    expect(body.state.selectedEvidence).toBe(quote);
    expect(body.state.question.id).toBe('q2');
    expect(body.state.officialDomains).toEqual(plan.officialDomains);
    return Response.json({ answers: { role: { type: 'choice', choice: 'unknown', confidence: 1 },
      relation: { type: 'choice', choice: 'context', confidence: 1 }, sufficient: { type: 'choice', choice: 'no', confidence: 1 } } });
  });
  const result = await model({ page: { url: 'https://example.org/', title: 'Source', text: quote, links: [] }, goal: 'Research',
    research: true, question: plan.questions[1], officialDomains: plan.officialDomains, visited: [], signal: new AbortController().signal });
  expect(result.assessment).toEqual({ role: 'unknown', relation: 'context', sufficient: false });
  expect(calls).toBe(2);
});

test('official specifications require an official source and Codex can downgrade an optimistic evidence judgment', () => {
  const q = { ...plan.questions[0]!, requireOfficial: true };
  const evidence: ResearchAssessment[] = [{ questionId: q.id, sourceId: 's1', role: 'external', relation: 'supports', sufficient: true }];
  expect(questionStatus(q, evidence)).toBe('partial');
  evidence[0]!.role = 'official';
  expect(questionStatus(q, evidence)).toBe('answered');
  const output = report(plan, evidence);
  output.answers[0]!.status = 'partial';
  expect(parseResearchReport(output, plan, evidence).answers[0]!.status).toBe('partial');
  output.answers[1]!.status = 'answered';
  expect(parseResearchReport(output, plan, evidence).answers[1]!.status).toBe('unconfirmed');
});

test('reading has a separate 40 read budget and preserves all 61 records through parsing and exports', async () => {
  let pageNumber = 0, reads = 0;
  const sections = Array.from({ length: 4 }, (_, index) => ({ id: `section_${index}`, title: `Section ${index}`, kind: 'text' as const, preview: 'Details' }));
  const page = () => ({ url: `https://example.org/${++pageNumber}`, title: 'Document', text: `Overview ${pageNumber}`, sections,
    links: [{ id: 'next', label: 'Next document', url: `https://example.org/${pageNumber + 1}` }] });
  const f = fixture({ load: async () => page(), follow: async () => page(),
    readSection: async (current, section) => { reads++; return { ...current, section, text: `${current.url} ${section.id}` }; },
    decide: async ({ page, readSections }) => ({ completed: false, confidence: 1, link: page.links[0] ?? null,
      section: page.sections?.find(section => !readSections?.includes(section.id)) }),
  });
  try {
    f.start(); await flush();
    const state = parseAutopilotState(f.runner.snapshot());
    expect(reads).toBe(40);
    expect(state.steps.filter(step => step.kind === 'navigation')).toHaveLength(21);
    expect(state.steps).toHaveLength(61);
    expect(state.phase).toBe('partial');
    expect(autopilotReport(state, 'markdown')).toContain('Navigation: 20/20; document reads: 40/40.');
    expect(autopilotReport(state, 'csv')).toContain('Document reading limit reached');
    expect(() => parseAutopilotState({ ...state, steps: [...state.steps, state.steps[1]] })).toThrow();
    expect(() => parseAutopilotState({ ...state, steps: state.steps.map(step => ({ ...step, kind: 'navigation' })) })).toThrow();
  } finally { f.runner.dispose(); }
});

test('the page reached by the final navigation can still be read and its evidence collected', async () => {
  let loads = 0;
  const section = { id: 'section_0', title: 'Answer', kind: 'text' as const, preview: quote };
  const page = () => ({ url: `https://example.org/${++loads}`, title: 'Page', text: '',
    sections: loads === 21 ? [section] : [], links: [{ id: 'next', label: 'Next', url: `https://example.org/${loads + 1}` }] });
  const f = fixture({ load: async () => page(), follow: async () => page(),
    readSection: async page => ({ ...page, section, text: quote }),
    decide: async ({ page }) => ({ completed: false, confidence: 1, link: page.links[0] ?? null,
      ...(!page.section && page.sections?.length ? { section } : {}),
      ...(page.section ? { evidence: { text: quote, confidence: 1 }, assessment: { role: 'official', relation: 'supports', sufficient: true } } : {}) }),
  });
  try {
    f.start(); await flush();
    const state = parseAutopilotState(f.runner.snapshot());
    expect(loads).toBe(21);
    expect(state.steps.filter(step => step.kind === 'reading')).toHaveLength(1);
    expect(state.sources?.[0]?.evidence).toBe(quote);
    expect(state.steps).toHaveLength(22);
  } finally { f.runner.dispose(); }
});

test('identical content under different section IDs stops without using the whole budget', async () => {
  let reads = 0;
  const sections = Array.from({ length: 4 }, (_, index) => ({ id: `section_${index}`, title: 'Repeated', kind: 'text' as const, preview: 'Same content' }));
  const f = fixture({ load: async () => ({ url: 'https://example.org/repeated', title: 'Document', text: 'Same content', links: [], sections }),
    readSection: async (page, section) => { reads++; return { ...page, section }; },
    decide: async ({ page, readSections }) => ({ completed: false, confidence: 1, link: null,
      section: page.sections?.find(section => !readSections?.includes(section.id)) }),
  });
  try {
    f.start(); await flush();
    const state = parseAutopilotState(f.runner.snapshot());
    expect(reads).toBe(4);
    expect(state.issues?.some(issue => issue.message.includes('without new evidence'))).toBe(true);
    expect(state.sources).toHaveLength(0);
    expect(state.phase).toBe('partial');
  } finally { f.runner.dispose(); }
});

test('Google results offer navigation but no document reading choices', async () => {
  const model = createAutopilotModel('fixture', async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body.questions.reading).toBeUndefined();
    return Response.json({ answers: { evidence: { type: 'choice', choice: 'none', confidence: 1 },
      links_0: { type: 'choice', choice: 'result', confidence: 1 } } });
  });
  const result = await model({ page: { url: 'https://www.google.com/search?q=rent', title: 'Results', text: 'Snippet',
    sections: [{ id: 'section_0', title: 'Court ruling', kind: 'text', preview: 'Snippet' }],
    links: [{ id: 'result', label: 'Court ruling', url: 'https://example.org/ruling' }] },
    goal: 'Research', research: true, question: plan.questions[0], visited: [], signal: new AbortController().signal });
  expect(result.section).toBeUndefined();
  expect(result.link?.url).toBe('https://example.org/ruling');
});
