import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillRegistry, runRegisteredSkill } from '../lib/skill-flow-registry.mts';
import { createResearchActions, researchSkill, RESEARCH_SKILL, type ResearchActions, type ResearchDocument, type ResearchRequest } from '../lib/skill-flow-research.mts';
import { createSkillFlowJudge, SKILL_FLOW_REQUEST_BYTES, type SkillFlowJudge, type SkillFlowQuestion } from '../lib/skill-flow-judge.mts';
import { readResearchSource } from '../lib/skill-flow-sources.mts';

const directories: string[] = [];
async function temporary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-research-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const source = { title: 'TypeSafe API', url: 'https://docs.typesafe.ai/api', notes: 'Choice는 선택한 항목을 반환합니다.' };
const input: ResearchRequest = { topic: 'Jev 반환값', requirements: ['Choice 반환값'], sources: [] };
const document: ResearchDocument = { sections: [{ heading: '반환값', text: source.notes, sources: [0] }] };
const metadata = { model: 'mock', inputTokens: null, outputTokens: null, elapsedMs: 1 };
function judge(values: boolean[], override?: (question: SkillFlowQuestion) => boolean | undefined): SkillFlowJudge {
  let index = 0;
  return async question => {
    const state = question.state as Record<string, unknown>;
    const value = override?.(question) ?? (Array.isArray(state.requirements) ? values[index++] ?? false : true);
    return { ...metadata, status: 'decided', value, choice: value ? 'yes' : 'no' };
  };
}
function actions(overrides: Partial<ResearchActions> = {}): ResearchActions {
  return { async read(url) { return { url, content: source.notes }; }, async research() { return [source]; },
    async write() { return document; }, ...overrides };
}
async function run(options: { judge?: SkillFlowJudge; actions?: ResearchActions; input?: ResearchRequest; signal?: AbortSignal } = {}) {
  return runRegisteredSkill(RESEARCH_SKILL, options.input ?? input, { registry: createSkillRegistry([researchSkill]),
    judge: options.judge ?? judge([false, true]), dependencies: { research: options.actions ?? actions() },
    outputRoot: await temporary(), mode: 'mock', signal: options.signal });
}
async function assertNoReport(result: Awaited<ReturnType<typeof run>>) {
  expect(result.outcome).toBe('fail');
  expect(result.artifacts).toEqual([]);
  expect(await readdir(path.dirname(result.reportPath))).not.toContain('report.md');
}

test('no -> research -> source verification -> yes -> document verification -> saved report', async () => {
  const result = await run();
  expect(result.outcome).toBe('success');
  expect(result.judgments.map(value => value.choice)).toEqual(['no', 'yes', 'yes', 'yes', 'yes']);
  const output = await readFile(result.artifacts[0]!, 'utf8');
  expect(output).toContain(`[TypeSafe API](<${source.url}>)`);
  expect(output).toContain(source.notes);
  const evidence = JSON.parse(await readFile(path.join(path.dirname(result.reportPath), 'evidence-1-0.json'), 'utf8'));
  expect(evidence).toMatchObject({ url: source.url, content: source.notes });
});

test('supplied evidence is fetched and verified before skipping additional research', async () => {
  let researches = 0, reads = 0;
  const result = await run({ input: { ...input, sources: [source] }, judge: judge([true]), actions: actions({
    async research() { researches++; return []; }, async read(url) { reads++; return { url, content: source.notes }; },
  }) });
  expect(result.outcome).toBe('success');
  expect(researches).toBe(0);
  expect(reads).toBe(1);
});

test('persistent no stops after two research rounds without a report', async () => {
  let researches = 0, writes = 0;
  const result = await run({ judge: judge([false]), actions: actions({ async research() { researches++; return [source]; },
    async write() { writes++; return document; } }) });
  await assertNoReport(result);
  expect(researches).toBe(2);
  expect(writes).toBe(0);
});

test.each(['requirement', 'section'])('injected unsupported %s fails its semantic verification', async field => {
  const result = await run({ judge: judge([false, true], question => field in (question.state as Record<string, unknown>) ? false : undefined) });
  await assertNoReport(result);
  expect(result.reason).toBe('validation_error');
});

test('unsupported sources are excluded and the two recovery rounds remain bounded', async () => {
  let researches = 0;
  const result = await run({ actions: actions({ async research() { researches++; return [source]; } }),
    judge: judge([false], question => 'content' in (question.state as Record<string, unknown>) ? false : undefined) });
  await assertNoReport(result);
  expect(result.reason).toBe('declined');
  expect(researches).toBe(2);
  const log = JSON.parse(await readFile(path.join(path.dirname(result.reportPath), 'sources-1.json'), 'utf8'));
  expect(log).toMatchObject({ verified: [], rejected: [{ url: source.url, reason: 'unsupported' }] });
});

test('one rejected source does not discard the good evidence or stop report writing', async () => {
  const bad = { ...source, url: 'https://example.com/bad', notes: 'incorrect' };
  const result = await run({ input: { ...input, sources: [source, bad] }, judge: judge([true], question => {
    const state = question.state as Record<string, unknown>;
    return 'content' in state ? state.notes !== 'incorrect' : undefined;
  }), actions: actions({ async write(request) {
    expect(request.sources).toEqual([source]);
    return document;
  } }) });
  expect(result.outcome).toBe('success');
});

test('additional research retains earlier verified sources even when the new response omits them', async () => {
  const extra = { ...source, url: 'https://example.com/new', notes: '추가 근거입니다.' };
  let researched = 0;
  const result = await run({ input: { ...input, sources: [source] }, judge: judge([false, true]),
    actions: actions({ async research(request) { researched++; expect(request.sources).toEqual([source]); return [extra]; },
      async write(request) { expect(request.sources).toEqual([source, extra]); return document; } }) });
  expect(result.outcome).toBe('success');
  expect(researched).toBe(1);
});

test('a source read failure can recover with a replacement source', async () => {
  const missing = { ...source, url: 'https://example.com/missing' };
  const result = await run({ input: { ...input, sources: [missing] }, actions: actions({ async read(url) {
    if (url === missing.url) throw new Error('unavailable');
    return { url, content: source.notes };
  } }) });
  expect(result.outcome).toBe('success');
});

test.each([false, true])('large evidence preserves every sentence and source; reject last sentence=%s', async rejectLast => {
  const sources = Array.from({ length: 6 }, (_, i) => ({ title: `자료${i}`, url: `https://example.com/${i}`, notes: '가'.repeat(1230) }));
  const content = `${'근거'.repeat(49)}. `.repeat(19) + '마지막 주장은 근거가 없습니다.';
  const passages: string[] = [];
  const primary = createSkillFlowJudge({ getKey: () => 'test', request: async (_url, init) => {
    const body = String(init.body);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(SKILL_FLOW_REQUEST_BYTES);
    const state = JSON.parse(body).state;
    if (state.section) {
      passages.push(state.section.text);
      expect(state.citedSources).toEqual(sources.map(({ notes }) => ({ notes })));
    }
    const choice = rejectLast && state.section?.text.endsWith('없습니다.') ? 'no' : 'yes';
    return Response.json({ answers: { condition: { type: 'choice', choice } } });
  } });
  const result = await run({ input: { ...input, sources }, judge: primary, actions: actions({
    async write() { return { sections: [{ heading: '설명', text: content, sources: [0, 1, 2, 3, 4, 5] }] }; },
  }) });
  expect(result.outcome).toBe(rejectLast ? 'fail' : 'success');
  if (rejectLast) await assertNoReport(result);
  expect(passages.length).toBeGreaterThan(1);
  expect(passages.join('')).toBe(content.trim().repeat(rejectLast ? 3 : 1));
});

test('irrelevant final document is submitted for Jev verification, then rejected', async () => {
  let inspected = false;
  const result = await run({ actions: actions({ async write() { return { sections: [
    { heading: '점심', text: '오늘은 국수를 먹습니다.', sources: [0] },
  ] }; } }), judge: judge([false, true], question => {
    const state = question.state as Record<string, unknown>;
    if ('requirement' in state) { inspected = JSON.stringify(state).includes('국수'); return false; }
    return undefined;
  }) });
  expect(inspected).toBe(true);
  await assertNoReport(result);
});

test('document exceeding the semantic input budget is rejected before publication', async () => {
  const result = await run({ actions: actions({ async write() { return { sections: Array.from({ length: 8 },
    () => ({ heading: '긴 문서', text: '가'.repeat(2000), sources: [0] })) }; } }) });
  await assertNoReport(result);
  expect(result.reason).toBe('validation_error');
});

test('known limit: a semantic verifier false positive can accept structurally valid false prose', async () => {
  const result = await run({ actions: actions({ async write() { return { sections: [
    { heading: '잘못된 설명', text: 'Choice는 항상 숫자 42를 반환합니다.', sources: [0] },
  ] }; } }), judge: judge([false, true]) });
  // Deliberately wrong yes decisions model the remaining limit, not a factual accuracy guarantee.
  expect(result.outcome).toBe('success');
  expect(await readFile(result.artifacts[0]!, 'utf8')).toContain('항상 숫자 42');
});

test.each(['https://invented.example', '[fake](https://invented.example)', '[fake][ref]', '<a href="x">fake</a>'])
('injected prose link is blocked before saving: %s', async text => {
  const result = await run({ actions: actions({ async write() { return { sections: [{ heading: '반환값', text, sources: [0] }] }; } }) });
  await assertNoReport(result);
  expect(result.reason).toBe('validation_error');
});

test.each([[-1], [99], ['0'], [], [0, 0]].map(sources => ({ sources })))('injected invalid citations are rejected: %j', async ({ sources }) => {
  const invalidWrite: ResearchActions['write'] = async (_request, _signal) => ({
    sections: [{ heading: '반환값', text: source.notes, sources }],
  }) as unknown as ResearchDocument;
  const result = await run({ actions: actions({ write: invalidWrite }) });
  await assertNoReport(result);
});

test('unreadable or invented source is never promoted into usable evidence', async () => {
  let writes = 0;
  const result = await run({ actions: actions({ async read() { throw new Error('private transport detail'); },
    async write() { writes++; return document; } }) });
  await assertNoReport(result);
  expect(writes).toBe(0);
  expect(await readFile(result.reportPath, 'utf8')).not.toContain('private transport detail');
});

test('empty reader output is invalid even if research claimed a completed web search', async () => {
  const result = await run({ actions: actions({ async read(url) { return { url, content: '' }; } }) });
  await assertNoReport(result);
  expect(result.reason).toBe('validation_error');
});

test('cancellation after writing response prevents document publication', async () => {
  const controller = new AbortController();
  const result = await run({ signal: controller.signal, actions: actions({ async write() { controller.abort(); return document; } }) });
  await assertNoReport(result);
  expect(result.reason).toBe('canceled');
});

test('research without an observed web call is rejected', async () => {
  const provider = createResearchActions(async () => ({ ...metadata, webSearches: 0, text: JSON.stringify({ sources: [source] }) }));
  let caught: unknown;
  try { await provider.research(input); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
});

test.each(['http://127.0.0.1/', 'http://[::1]/'])('source reader rejects non-public addresses: %s', async url => {
  let caught: unknown;
  try { await readResearchSource(url); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain('not a public address');
});
