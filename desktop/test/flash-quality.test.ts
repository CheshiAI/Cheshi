import { expect, test } from 'bun:test';
import { memoryReranker } from '../lib/flash/rerank.mts';
import { summaryPassages, verifiedSummarizer, type SummaryInput } from '../lib/flash/summary.mts';
import { FlashError } from '../lib/flash/client.mts';
import { flashRelayFailure } from '../lib/agent-orchestration/flash-relay.mts';
import { rejection } from './flash-test-helpers.ts';
import { account, deferred, fixtureSummary, flashFixture, history, session } from './flash-test-helpers.ts';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';

const signal = new AbortController().signal;
const input: SummaryInput = { question: 'Windows 설치 실측 결과는?', turns: [{ session_id: 's', turn_id: 't', messages: [
  { session_id: 's', turn_id: 't', source_id: 'a', message_id: 'a', kind: 'assistant', entry: 1,
    text: '개발앱에서 연결을 확인했습니다. 정식 배포는 별도 과제입니다.' },
] }] };
const supported = { summary: '운영체제가 명시되지 않아 Windows 설치 실측은 확인할 수 없습니다.',
  insufficient_evidence: true, evidence: [{ source_id: 'a', quote: input.turns[0]!.messages[0]!.text }] };
const selected = { ...supported, evidence: ['p0'] };

test('ranking reorders original objects across origins without rewriting provenance or using corpus ranks', async () => {
  const candidates = [{ origin: 'docker', text: 'unrelated', rank_score: 1 }, { origin: 'local', text: 'answer', rank_score: .001 }];
  const rank = memoryReranker(async (_instructions, payload) => {
    expect(payload).toEqual({ question: 'why?', passages: [{ index: 0, kind: undefined, text: 'unrelated' }, { index: 1, kind: undefined, text: 'answer' }] });
    return { order: [1, 0] };
  });
  const result = await rank('why?', candidates, signal);
  expect(result[0]).toBe(candidates[1]); expect(result[1]).toBe(candidates[0]);
});

test('ranking refuses empty, duplicated, foreign and noninteger candidates', async () => {
  for (const order of [[], [0, 0], [0, 2], [0, .5], ['0', 1]]) {
    const rank = memoryReranker(async () => ({ order }));
    expect(await rejection(() => rank('why', [{ text: 'a' }, { text: 'b' }], signal))).toMatchObject({ code: 'invalid_ranking' });
  }
});

test('semantic review receives originals and question, replacing an unsupported draft before publication', async () => {
  let calls = 0;
  const summarize = verifiedSummarizer(async (_instructions, payload) => {
    calls++;
    if (calls === 1) return { ...selected, summary: 'Windows 설치를 검증했습니다.', insufficient_evidence: false };
    expect(payload).toMatchObject({ ...summaryPassages(input).payload, draft: { summary: 'Windows 설치를 검증했습니다.' } });
    return selected;
  });
  expect(await summarize(input, signal)).toEqual(supported);
  expect(calls).toBe(2);
});

test('bad citations get one repair, and semantic review still cannot return invented quotes', async () => {
  let calls = 0;
  const summarize = verifiedSummarizer(async () => {
    calls++;
    return calls === 2 ? selected : { ...selected, evidence: ['foreign-passage'] };
  });
  expect(await rejection(() => summarize(input, signal))).toMatchObject({ code: 'invalid_summary' });
  expect(calls).toBe(4);
});

test('passage references preserve Unicode, Markdown, line endings and exact message ownership', async () => {
  const text = '🙂 **테스트용**\r\n\r\n실측 아님.\r다음\n';
  const original = input.turns[0]!.messages[0]!;
  const turns = [{ session_id: 's', turn_id: 't', messages: [
    { ...original, source_id: 'a'.repeat(64), text },
    { ...original, source_id: 'b'.repeat(64), message_id: 'b', entry: 2, text: '실측 아님.' },
  ] }];
  const mapped = summaryPassages({ question: '실측했어?', turns });
  expect(mapped.payload.turns[0]!.messages[0]!.passages.map(p => p.text).join('')).toBe(text);
  const id = [...mapped.evidence].find(([, e]) => e.source_id === 'b'.repeat(64))![0];
  const summarize = verifiedSummarizer(async () => ({ summary: '실측하지 않았습니다.', insufficient_evidence: false, evidence: [id] }));
  expect(await summarize({ question: '실측했어?', turns }, signal)).toMatchObject({ evidence: [{ source_id: 'b'.repeat(64), quote: '실측 아님.' }] });
});

test('passage selection cannot cite blanks or bypass schema validation with fabricated evidence objects', async () => {
  for (const evidence of [['p9999'], [{ source_id: 'a', quote: 'invented' }], [0]]) {
    const summarize = verifiedSummarizer(async () => ({ ...selected, evidence }));
    expect(await rejection(() => summarize(input, signal))).toMatchObject({ code: 'invalid_summary' });
  }
  const blank = structuredClone(input);
  blank.turns[0]!.messages[0]!.text = '\n';
  const summarize = verifiedSummarizer(async () => selected);
  expect(await rejection(() => summarize(blank, signal))).toMatchObject({ code: 'invalid_summary' });
});

test('provider failures are not blindly retried and relay exposes only known redacted categories', async () => {
  let calls = 0;
  const summarize = verifiedSummarizer(async () => { calls++; throw new FlashError('model_unavailable', 'PRIVATE INPUT'); });
  const error = await rejection(() => summarize(input, signal));
  expect(calls).toBe(1);
  const result = flashRelayFailure(error, signal);
  expect(result).toMatchObject({ isError: true, code: 'model_unavailable', retryable: true });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(flashRelayFailure(new FlashError('SECRET CATEGORY', 'SECRET BODY'), signal).code).toBe('unavailable');
  const canceled = new AbortController(); canceled.abort();
  expect(flashRelayFailure(error, canceled.signal).code).toBe('canceled');
});

test('short rankings keep omitted original candidates and malformed rankings get only one repair', async () => {
  const candidates = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  let calls = 0;
  const rank = memoryReranker(async () => ++calls === 1 ? { order: [2, 2] } : { order: [2] });
  expect(await rank('why', candidates, signal)).toEqual([candidates[2]!, candidates[0]!, candidates[1]!]);
  expect(calls).toBe(2);
});

test('local ranking releases grants during inference and refuses an original edited while ranking', async () => {
  const fixture = await flashFixture();
  const entered = deferred<void>(), finish = deferred<void>();
  let raw = history();
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: fixture.host,
    source: { list: async () => ({ sessions: [session()] }), read: async () => raw }, summarize: fixtureSummary,
    rerank: async (_query, candidates) => { entered.resolve(); await finish.promise; return candidates; },
  });
  memory.accounts(account());
  try {
    const pending = rejection(() => memory.execute('memory_search', { query: 'why', limit: 1 }, 'caller', signal));
    await entered.promise;
    expect(fixture.grants.size).toBe(0);
    raw = history('Edited during ranking'); finish.resolve();
    expect(await pending).toMatchObject({ code: 'stale_source' });
  } finally { finish.resolve(); await memory.dispose(); await fixture.close(); }
});
