import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillRegistry, runRegisteredSkill } from '../lib/skill-flow-registry.mts';
import { researchSkill, researchDocument, createResearchActions, type ResearchActions, type ResearchRequest } from '../lib/skill-flow-research.mts';
import { researchProse, renderResearchProse, validateRenderedResearch } from '../lib/skill-flow-research-validation.mts';
import type { SkillFlowJudge, SkillFlowQuestion } from '../lib/skill-flow-judge.mts';
import type { ResearchWriteFeedback } from '../lib/skill-flow-research-writing.mts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const source = { title: 'API [guide]', url: 'https://example.com/api', notes: 'Choice는 선택한 키를 반환합니다.' };
const input: ResearchRequest = { topic: 'Choice', requirements: ['반환값 설명'], sources: [source] };
const valid = { sections: [{ heading: '반환값', text: 'Choice는 선택한 키를 반환합니다.', sources: [0] }] };
const metadata = { model: 'mock', inputTokens: null, outputTokens: null, elapsedMs: 0 };
function judge(predicate: (question: SkillFlowQuestion) => boolean = () => true): SkillFlowJudge {
  return async question => {
    const value = predicate(question);
    return { ...metadata, status: 'decided', value, choice: value ? 'yes' : 'no' };
  };
}
async function run(options: { write?: ResearchActions['write']; research?: ResearchActions['research']; input?: ResearchRequest;
  judge?: SkillFlowJudge; signal?: AbortSignal; timeoutMs?: number; maxJudgments?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-repair-'));
  roots.push(root);
  return runRegisteredSkill(researchSkill.name, options.input ?? input, {
    registry: createSkillRegistry([researchSkill]), judge: options.judge ?? judge(), mode: 'mock', outputRoot: root,
    signal: options.signal, timeoutMs: options.timeoutMs, maxJudgments: options.maxJudgments,
    dependencies: { research: { async read(url: string) { return { url, content: source.notes }; },
      research: options.research ?? (async () => []), write: options.write ?? (async () => valid) } satisfies ResearchActions },
  });
}
async function attempt(result: Awaited<ReturnType<typeof run>>, index: number) {
  return JSON.parse(await readFile(path.join(path.dirname(result.reportPath), `writing-${index}.json`), 'utf8'));
}

test.each(['선택지는 [yes, no]입니다.', '결과는 `answers.<question_id>` 아래에 있습니다.',
  '질문 ID별 결과는 answers.<question_id> 아래에 반환됩니다.',
  '타입은 `Array<string>`입니다.', '`[example](https://example.com)`은 코드 예제입니다.',
  '```ts\nconst values = ["yes", "no"];\n```'])('literal technical notation remains usable: %s', text => {
  expect(researchDocument({ sections: [{ heading: '반환값', text, sources: [0] }] }, input).sections[0]?.text).toBe(text);
});

test('bare placeholders are escaped without corrupting the same placeholder in code', () => {
  const raw = '`answers.<question_id>`와 answers.<question_id> 및 `<a>`를 구분합니다.';
  expect(renderResearchProse(raw)).toBe('`answers.<question_id>`와 answers.&lt;question_id&gt; 및 `<a>`를 구분합니다.');
});

const normalizedMarkdownCases = [
  ['wrapped list', '- 첫 항목은 여러 줄로\n  이어지는 문장입니다.'],
  ['blockquote', '> 첫 줄\n> 두 번째 줄'],
  ['escaped table pipe', '| 필드 | 값 |\n| --- | --- |\n| a\\|b | `x` |'],
  ['code in list', '- 예제:\n\n  ```ts\n  const arr = [1, 2];\n  console.log(arr);\n  ```'],
  ['code in blockquote', '> ```ts\n> const arr = [1, 2];\n> ```'],
  ['crlf', '첫 줄\r\n둘째 줄'],
] as const;

test.each(normalizedMarkdownCases)('%s survives validation and full report writing without repair', async (_name, text) => {
  expect(researchProse(text, 2000, 'probe')).toBe(text);
  expect(renderResearchProse(text)).toBe(text);
  let writes = 0;
  const result = await run({ write: async () => {
    writes++;
    return { sections: [{ heading: '본문', text, sources: [0] }] };
  } });
  expect(result.outcome).toBe('success');
  expect(writes).toBe(1);
  expect(await readFile(result.artifacts[0]!, 'utf8')).toContain(text);
  expect(await attempt(result, 1)).toMatchObject({ status: 'accepted', issues: [] });
});

test.each([
  ['> `answers.<question_id>`\n> answers.<question_id>', '> `answers.<question_id>`\n> answers.&lt;question_id&gt;'],
  ['- `answers.<question_id>`\n  answers.<question_id>', '- `answers.<question_id>`\n  answers.&lt;question_id&gt;'],
  ['> ```ts\n> answers.<question_id>\n> ```\n> answers.<question_id>',
    '> ```ts\n> answers.<question_id>\n> ```\n> answers.&lt;question_id&gt;'],
  ['| 코드 | 본문 |\n| --- | --- |\n| `<question_id>` | a\\|b <question_id> |',
    '| 코드 | 본문 |\n| --- | --- |\n| `<question_id>` | a\\|b &lt;question_id&gt; |'],
  ['`<question_id>`\r\n값 <question_id>', '`<question_id>`\r\n값 &lt;question_id&gt;'],
  ['\\<question_id>와 <question_id>', '\\<question_id>와 &lt;question_id&gt;'],
  ['`<cheshiplaceholder_0>`와 <cheshiplaceholder_0>', '`<cheshiplaceholder_0>`와 &lt;cheshiplaceholder_0&gt;'],
])('placeholder escaping preserves literal code and original layout: %s', (raw, expected) => {
  expect(renderResearchProse(raw)).toBe(expected);
  validateRenderedResearch(expected, []);
});

test.each([
  '> 첫 줄\n> [click](https://invented.example)',
  '- 첫 줄\n  <a href="https://invented.example">click</a>',
  '| 필드 | 값 |\n| --- | --- |\n| a\\|b | ![image](https://invented.example/a.png) |',
  '첫 줄\r\nhttps://invented.example',
])('normalized containers still reject active markup: %s', text => {
  expect(() => researchProse(text, 2000, 'probe')).toThrow();
});

test.each(['[click](https://invented.example)', '[click](/unverified)', '<https://invented.example>',
  'https://invented.example', 'www.invented.example', '<a href="https://invented.example">click</a>',
  '![image](https://invented.example/image.png)', '[ref]: https://invented.example', '[click][ref]'])
('active markup still fails with an exact field: %s', text => {
  let caught: unknown;
  try { researchDocument({ sections: [{ heading: '반환값', text, sources: [0] }] }, input); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ issue: { code: 'forbidden_markup', field: 'sections[0].text' } });
});

test('code notation and array-bearing source titles survive full report rendering', async () => {
  const result = await run({ write: async () => ({ sections: [{ heading: '반환값',
    text: '선택지는 [yes, no]이고, 결과는 `answers.<question_id>`입니다.', sources: [0] }] }) });
  expect(result.outcome).toBe('success');
  expect(await readFile(result.artifacts[0]!, 'utf8')).toContain('`answers.<question_id>`');
  expect(await attempt(result, 1)).toMatchObject({ status: 'accepted', issues: [] });
});

test('assembled Markdown cannot turn independently literal fragments into an unverified link', () => {
  const first = '```\nexample';
  const second = '```\n[click](https://invented.example)';
  expect(researchProse(first, 2000, 'first')).toBe(first);
  expect(researchProse(second, 2000, 'second')).toBe(second);
  expect(() => validateRenderedResearch(`${first}\n\n${second}`, [])).toThrow();
});

test('invalid citation is recorded and repaired once with original response and field feedback', async () => {
  const feedbacks: Array<ResearchWriteFeedback | undefined> = [];
  const result = await run({ async write(_request, _signal, feedback) {
    feedbacks.push(feedback);
    return feedback ? JSON.stringify(valid) : JSON.stringify({ sections: [{ ...valid.sections[0], sources: [99] }] });
  } });
  expect(result.outcome).toBe('success');
  expect(feedbacks).toHaveLength(2);
  expect(feedbacks[0]).toBeUndefined();
  expect(feedbacks[1]).toMatchObject({ issues: [{ code: 'invalid_citations', field: 'sections[0].sources' }] });
  expect(feedbacks[1]?.previousDraft).toContain('99');
  expect(await attempt(result, 1)).toMatchObject({ status: 'rejected', issues: [{ code: 'invalid_citations', field: 'sections[0].sources' }] });
  expect(await attempt(result, 2)).toMatchObject({ status: 'accepted', issues: [] });
});

test('persistent malformed JSON stops after three writes and retains all failed responses', async () => {
  let writes = 0;
  const result = await run({ async write() { writes++; return '{ malformed'; } });
  expect(result).toMatchObject({ outcome: 'fail', reason: 'validation_error', artifacts: [] });
  expect(writes).toBe(3);
  for (let i = 1; i <= 3; i++) expect(await attempt(result, i)).toMatchObject({ status: 'rejected',
    draft: { content: '{ malformed', truncated: false }, issues: [{ code: 'invalid_json', field: 'response' }] });
  expect(await readdir(path.dirname(result.reportPath))).not.toContain('report.md');
});

test('an unmet requirement repairs the draft and repeats semantic verification', async () => {
  let writes = 0;
  const result = await run({ async write(_request, _signal, feedback) {
    writes++;
    if (feedback) expect(feedback.issues).toEqual([{ code: 'requirement_unmet', field: 'requirements[0]' }]);
    return feedback ? valid : { sections: [{ ...valid.sections[0], text: '무관한 내용입니다.' }] };
  }, judge: judge(question => !('requirement' in (question.state as object)) || !JSON.stringify(question.state).includes('무관한')) });
  expect(result.outcome).toBe('success');
  expect(writes).toBe(2);
});

test('provider exceptions never become repeated writing or exposed error details', async () => {
  let writes = 0;
  const result = await run({ async write() { writes++; throw new Error('private provider message'); } });
  expect(writes).toBe(1);
  expect(result.reason).toBe('workflow_error');
  expect(await attempt(result, 1)).toEqual({ attempt: 1, status: 'provider_error' });
});

test('a Jev failure during draft validation is not a reason to ask Luna to rewrite', async () => {
  let writes = 0;
  const primary: SkillFlowJudge = async question => 'requirement' in (question.state as object)
    ? { ...metadata, status: 'error', value: null, choice: null, reason: 'network' }
    : judge()(question);
  const result = await run({ judge: primary, async write() { writes++; return valid; } });
  expect(result.reason).toBe('judge_error');
  expect(writes).toBe(1);
  expect(await attempt(result, 1)).toMatchObject({ status: 'validation_interrupted' });
});

test('repair stops when the shared judgment budget is exhausted', async () => {
  const result = await run({ maxJudgments: 3, judge: judge(question => !('requirement' in (question.state as object))) });
  expect(result.reason).toBe('call_limit');
  expect(result.judgments).toHaveLength(3);
});

test.each(['count', 'bytes'])('Jev can retain new essential evidence at the %s capacity boundary', async capacity => {
  const existing = Array.from({ length: capacity === 'count' ? 6 : 4 }, (_, i) => ({
    title: `기존${i}`, url: `https://example.com/old${i}`, notes: capacity === 'count' ? '기존 자료' : '가'.repeat(1500),
  }));
  const added = [{ title: '핵심', url: 'https://example.com/essential', notes: capacity === 'count' ? '핵심 자료' : '핵심' + '나'.repeat(1498) }];
  if (capacity === 'bytes') added.push({ title: '보충', url: 'https://example.com/more', notes: '다'.repeat(1500) });
  let selected: string[] = [];
  const result = await run({ input: { ...input, sources: existing }, research: async () => added,
    judge: judge(question => {
      const state = question.state as Record<string, unknown>;
      if (state.selection) {
        const selection = state.selection as { candidate: { url: string }; incumbent: { url: string } };
        return selection.candidate.url.endsWith('/essential') && !selection.incumbent.url.endsWith('/essential');
      }
      if (state.requirements) return JSON.stringify(state.sources).includes('/essential');
      return true;
    }), async write(request) { selected = request.sources.map(source => source.url); return valid; },
  });
  expect(result.outcome).toBe('success');
  expect(selected).toContain('https://example.com/essential');
  expect(selected.length).toBeLessThanOrEqual(6);
  const log = JSON.parse(await readFile(path.join(path.dirname(result.reportPath), 'selection-1.json'), 'utf8'));
  expect(log.comparisons.length).toBeGreaterThan(0);
  expect(log.excluded.length).toBeGreaterThan(0);
  expect(log.excluded[0].reason).toBe(capacity === 'count' ? 'count_limit' : 'byte_limit');
});

test('Luna repair receives structured feedback through a tool-free writing call', async () => {
  let captured: unknown;
  const actions = createResearchActions(async request => {
    expect(request.research).toBeUndefined();
    captured = JSON.parse(request.input);
    return { ...metadata, webSearches: 0, text: JSON.stringify(valid) };
  });
  const feedback: ResearchWriteFeedback = { issues: [{ code: 'invalid_json', field: 'response' }], previousDraft: 'bad' };
  expect(await actions.write(input, undefined, feedback)).toBe(JSON.stringify(valid));
  expect(captured).toMatchObject({ feedback });
});
