import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatHistorySearch } from '../lib/chat-history-search.mts';
import { ChatHistoryRecall } from '../lib/chat-history-recall.mts';
import type { RecallEvaluator } from '../lib/chat-history-recall-model.mts';
import { recallResponseUsage } from '../lib/chat-history-recall-usage.mts';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const cwd = '/workspace/history';
const signal = () => new AbortController().signal;
const query = { query: '지난번 계정 전환을 포기한 사유는?', threadId: 'current', scope: 'thread' };

function thread(id: string, messages: string[], directory = cwd) {
  return { id, cwd: directory, turns: messages.map((text, index) => ({ id: `turn-${index}`, items: [
    { id: `message-${index}`, type: 'agentMessage', text },
  ] })) };
}
async function fixture(evaluate: RecallEvaluator = async (_query, candidates) => candidates.map(candidate => ({
  answer: candidate.text.includes('자격 증명') ? 0.94 : 0.05,
  related: candidate.text.includes('재개') ? 0.95 : 0.05,
  direct: 0.9,
}))) {
  const directory = await mkdtemp(join(tmpdir(), 'cheshi-recall-'));
  directories.push(directory);
  const threads = new Map<string, ReturnType<typeof thread>>();
  const failed = new Set<string>();
  const reads: string[] = [];
  const history = new ChatHistorySearch({ directory, cwd, source: {
    async list() { return { sessions: [...threads.keys()].map(id => ({ id, title: id, updatedAt: 1 })) }; },
    async read(id) { reads.push(id); if (failed.has(id)) throw new Error('unavailable'); return { thread: threads.get(id) }; },
  } });
  return { threads, failed, reads, history, recall: new ChatHistoryRecall({ history, evaluate }) };
}
async function failure(operation: Promise<unknown>, pattern: RegExp) {
  let reason: unknown;
  try { await operation; } catch (error) { reason = error; }
  expect(reason).toBeInstanceOf(Error);
  expect((reason as Error).message).toMatch(pattern);
}

test('recovers original source ids even without lexical overlap and includes later changed decisions', async () => {
  const f = await fixture();
  f.threads.set('current', thread('current', ['프로필 교체는 자격 증명 격리가 안 되어 중단했습니다.', '문제를 해결하여 재개했습니다.']));
  f.threads.set('other', thread('other', ['다른 작업의 자격 증명입니다.']));
  const result = await f.recall.search(query, signal());
  expect(result.status).toBe('candidates');
  expect(result.partial).toBe(false);
  expect(result.matches).toHaveLength(2);
  expect(result.matches.find(match => match.answerScore > 0.7)).toMatchObject({
    threadId: 'current', turnId: 'turn-0', itemId: 'message-0', text: '프로필 교체는 자격 증명 격리가 안 되어 중단했습니다.',
  });
  expect(result.matches.some(match => match.text.includes('재개'))).toBe(true);
  expect(f.reads.every(id => id === 'current')).toBe(true);
  const original = await f.recall.read({ threadId: 'current', turnId: 'turn-0', itemId: 'message-0' }, signal());
  expect(original.text).toBe('프로필 교체는 자격 증명 격리가 안 되어 중단했습니다.');
  expect(original.neighbors[0]?.text).toContain('재개');
});

test('expands to saved workspace conversations and rejects foreign or inaccessible sources', async () => {
  const f = await fixture();
  f.threads.set('current', thread('current', ['새 대화입니다.']));
  f.threads.set('past', thread('past', ['자격 증명 때문에 중단했습니다.']));
  f.threads.set('foreign', thread('foreign', ['자격 증명'], '/other/workspace'));
  f.threads.set('unavailable', thread('unavailable', ['자격 증명']));
  f.failed.add('unavailable');
  expect((await f.recall.search(query, signal())).status).toBe('not_found');
  const result = await f.recall.search({ ...query, scope: 'workspace' }, signal());
  expect(result.matches.map(match => match.threadId)).toEqual(['past']);
  expect(result.partial).toBe(true);
  expect(result.unavailableSessions.sort()).toEqual(['foreign', 'unavailable']);
  await failure(f.recall.read({ threadId: 'foreign', turnId: 'turn-0', itemId: 'message-0' }, signal()), /unavailable/);
});

test('an unscoped question retrieves another conversation in one search while explicit thread scope stays local', async () => {
  const f = await fixture();
  f.threads.set('current', thread('current', ['새 대화입니다.']));
  f.threads.set('past', thread('past', ['자격 증명 때문에 중단했습니다.']));
  const result = await f.recall.search({ query: query.query, threadId: query.threadId }, signal());
  expect(result.scope).toBe('workspace');
  expect(result.originals).toMatchObject([{ threadId: 'past', text: '자격 증명 때문에 중단했습니다.', truncated: false }]);
  f.reads.length = 0;
  expect((await f.recall.search(query, signal())).originals).toEqual([]);
  expect(f.reads.every(id => id === 'current')).toBe(true);
});

test('does not turn a forced best candidate into an answer when all scores are low', async () => {
  const f = await fixture();
  f.threads.set('current', thread('current', ['아무 관련 없는 기록입니다.']));
  expect(await f.recall.search(query, signal())).toMatchObject({ status: 'not_found', matches: [], originals: [], partial: false });
});

test.each(['delete', 'inaccessible', 'edited'] as const)('revalidates evidence after evaluation: %s', async mode => {
  const f = await fixture(async (_query, candidates) => {
    if (mode === 'delete') await f.history.remove(['current']);
    if (mode === 'inaccessible') f.failed.add('current');
    if (mode === 'edited') f.threads.set('current', thread('current', ['수정한 기록']));
    return candidates.map(() => ({ answer: 0.99, related: 0.99, direct: 0.9 }));
  });
  f.threads.set('current', thread('current', ['자격 증명']));
  const result = await f.recall.search(query, signal());
  expect(result).toMatchObject({ status: 'incomplete', matches: [], originals: [], partial: true, invalidated: 1 });
});

test('reports coverage and searches subsequent pages with an unchanged fingerprint', async () => {
  const f = await fixture();
  f.threads.set('current', thread('current', Array.from({ length: 30 }, (_, i) => `unrelated ${i}`)));
  const first = await f.recall.search(query, signal());
  expect(first).toMatchObject({ status: 'incomplete', evaluatedPassages: 24, nextOffset: 24, totalPassages: 30 });
  const next = await f.recall.search({ ...query, offset: first.nextOffset, snapshot: first.snapshot }, signal());
  expect(next).toMatchObject({ evaluatedPassages: 6, nextOffset: null, partial: true });
  f.threads.set('current', thread('current', ['changed']));
  await failure(f.recall.search({ ...query, offset: 24, snapshot: first.snapshot }, signal()), /changed/);
});

test('long message tails remain searchable and exact original text is paginated', async () => {
  const f = await fixture();
  const text = '😀'.repeat(3500) + '자격 증명';
  f.threads.set('current', thread('current', [text]));
  const result = await f.recall.search(query, signal());
  expect(result.matches.some(match => match.text.includes('자격 증명'))).toBe(true);
  const inline = result.originals[0]!;
  expect(inline.text).toContain('자격 증명');
  expect(inline.text.length).toBeLessThanOrEqual(4000);
  expect(inline.truncated).toBe(true);
  expect(inline.offset).toBeGreaterThan(0);
  expect(inline.text).toBe(text.slice(inline.offset, inline.nextOffset ?? text.length));
  expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(inline.text)).toBe(false);
  const first = await f.recall.read({ threadId: 'current', turnId: 'turn-0', itemId: 'message-0' }, signal());
  const next = await f.recall.read({ threadId: 'current', turnId: 'turn-0', itemId: 'message-0', offset: first.nextOffset }, signal());
  expect(first.text + next.text).toBe(text);
});

test('inline originals deduplicate message chunks and bound sources and surrounding context', async () => {
  const f = await fixture(async (_q, candidates) => candidates.map(p => ({
    answer: p.text.startsWith('source ') ? 0.99 : 0.9, related: 0.9, direct: 0.9,
  })));
  const texts = ['earlier '.repeat(200), '😀'.repeat(1000), 'source '.repeat(700), 'latest '.repeat(150)].map(text => text.trim());
  f.threads.set('current', thread('current', texts));
  const result = await f.recall.search(query, signal());
  expect(result.originals).toHaveLength(3);
  expect(new Set(result.originals.map(p => p.itemId)).size).toBe(3);
  for (const original of result.originals) {
    const text = texts[original.ordinal]!;
    expect(original.text.length).toBeLessThanOrEqual(4000);
    expect(original.text).toBe(text.slice(original.offset, original.nextOffset ?? text.length));
    expect(original.neighbors.length).toBeLessThanOrEqual(2);
    for (const neighbor of original.neighbors) {
      expect(neighbor.threadId).toBe('current');
      expect(neighbor.itemId).not.toBe(original.itemId);
      expect(neighbor.text.length).toBeLessThanOrEqual(600);
      expect(neighbor.truncated).toBe(true);
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(neighbor.text)).toBe(false);
    }
  }
  const truncated = result.originals.find(p => p.nextOffset !== null)!;
  const remainder = await f.recall.read({ ...truncated, offset: truncated.nextOffset }, signal());
  expect(truncated.text + remainder.text).toBe(texts[truncated.ordinal]!.slice(truncated.offset));
});

test('cancellation returns no evidence and no model call for an already cancelled request', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return []; });
  f.threads.set('current', thread('current', ['자격 증명']));
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await failure(f.recall.search(query, controller.signal), /cancelled/);
  expect(calls).toBe(0);
});

test('flags later corrections appended during evaluation and does not claim complete coverage', async () => {
  const f = await fixture(async (_query, candidates) => {
    f.threads.set('current', thread('current', ['자격 증명 때문에 포기', '중간 기록', '수정 후 재개']));
    return candidates.map(() => ({ answer: 0.9, related: 0.8, direct: 0.9 }));
  });
  f.threads.set('current', thread('current', ['자격 증명 때문에 포기', '중간 기록']));
  expect(await f.recall.search(query, signal())).toMatchObject({ partial: true, changedDuringSearch: true });
});

test('bounds returned text while preserving ids for other relevant matches', async () => {
  const f = await fixture(async (_query, candidates) => candidates.map(() => ({ answer: 0.9, related: 0.9, direct: 0.9 })));
  f.threads.set('current', thread('current', Array.from({ length: 12 }, (_, i) => `자격 증명 ${i}`)));
  const result = await f.recall.search(query, signal());
  expect(result.matches).toHaveLength(6);
  expect(result.originals).toHaveLength(3);
  expect(result.otherMatches).toHaveLength(6);
  expect(result.otherMatches[0]?.itemId).toBeString();
});

test('a missing thread is incomplete, not evidence that the answer does not exist', async () => {
  const f = await fixture();
  expect(await f.recall.search(query, signal())).toMatchObject({ status: 'incomplete', partial: true, unavailableSessions: ['current'] });
});

test('workspace ranking reaches an exact subject before unrelated current-thread chatter', async () => {
  const f = await fixture(async (_query, candidates) => candidates.map(p => ({ answer: p.text.includes('Aside') ? 0.95 : 0, related: 0, direct: 0.9 })));
  f.threads.set('current', thread('current', Array.from({ length: 60 }, (_, i) => `기능 구현 진행 기록 ${i}`)));
  f.threads.set('Aside처럼 구현하기', thread('Aside처럼 구현하기', ['Aside 같은 Autopilot을 구현했습니다.']));
  const result = await f.recall.search({ query: 'aside 형태의 기능', threadId: 'current', scope: 'workspace' }, signal());
  expect(result.matches[0]?.threadId).toBe('Aside처럼 구현하기');
  expect(result.nextOffset).toBe(1);
  expect(result.partial).toBe(true);
});

test('title-only relevance is evaluated early without excluding semantic candidates', async () => {
  const seen: string[] = [];
  const f = await fixture(async (_query, candidates) => {
    seen.push(...candidates.map(p => p.title ?? ''));
    return candidates.map(() => ({ answer: 0, related: 0, direct: 0.9 }));
  });
  f.threads.set('current', thread('current', Array.from({ length: 30 }, (_, i) => `진행 ${i}`)));
  f.threads.set('Aside처럼 구현하기', thread('Aside처럼 구현하기', ['메뉴에 Autopilot을 추가했습니다.']));
  const args = { query: 'aside', threadId: 'current', scope: 'workspace' };
  const first = await f.recall.search(args, signal());
  expect(seen[0]).toBe('Aside처럼 구현하기');
  const next = await f.recall.search({ ...args, offset: first.nextOffset, snapshot: first.snapshot }, signal());
  expect(next.nextOffset).toBe(25);
  const last = await f.recall.search({ ...args, offset: next.nextOffset, snapshot: next.snapshot }, signal());
  expect(last.nextOffset).toBeNull();
  expect(seen).toHaveLength(31);
});

test('cached assessments are reused across scopes with zero incremental API cost and source edits invalidate them', async () => {
  let calls = 0;
  const f = await fixture(async (_query, candidates, _signal, onUsage) => {
    calls++;
    onUsage?.(recallResponseUsage({ model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 50 } }, 10));
    return candidates.map(() => ({ answer: 0.9, related: 0.1, direct: 0.9 }));
  });
  f.threads.set('current', thread('current', ['자격 증명 때문에 중단']));
  const first = await f.recall.search(query, signal());
  expect(first.metrics.requests).toBe(1);
  expect(first.metrics.estimatedCostUsd).toBeCloseTo(0.000042, 10);
  expect(first.originals[0]?.text).toBe('자격 증명 때문에 중단');
  expect(f.reads).toEqual(['current', 'current']);
  const cached = await f.recall.search({ ...query, scope: 'workspace' }, signal());
  expect(cached.originals).toEqual(first.originals);
  expect(cached.metrics).toMatchObject({
    requests: 0, cacheHits: 1, inputTokens: 0, estimatedCostUsd: 0,
  });
  expect(calls).toBe(1);
  f.threads.set('current', thread('current', ['수정한 자격 증명 기록']));
  expect((await f.recall.search(query, signal())).metrics.requests).toBe(1);
  expect(calls).toBe(2);
  f.failed.add('current');
  expect((await f.recall.search(query, signal())).matches).toHaveLength(0);
});

test('later-correction search preserves current thread identity and searches the discovered source only', async () => {
  const f = await fixture();
  f.threads.set('current', thread('current', ['현재 작업']));
  f.threads.set('past', thread('past', ['자격 증명 때문에 포기', '다른 이야기', '문제를 해결하여 재개했습니다.']));
  const result = await f.recall.search({ ...query, focusThreadId: 'past', afterOrdinal: 0 }, signal());
  expect(result.totalPassages).toBe(2);
  expect(result.matches.map(m => m.itemId)).toEqual(['message-2']);
  expect(f.reads.every(id => id === 'past')).toBe(true);
  await failure(f.recall.search({ ...query, afterOrdinal: 0 }, signal()), /requires focusThreadId/);
});

test('failed evaluations retain known spending and mark unknown requests without returning unverified matches', async () => {
  const f = await fixture(async (_q, _c, _s, onUsage) => {
    onUsage?.(recallResponseUsage({ model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 10 } }, 5));
    onUsage?.(recallResponseUsage(undefined, 5));
    throw new Error('TypeSafe history search failed (HTTP 429).');
  });
  f.threads.set('current', thread('current', ['자격 증명']));
  const result = await f.recall.search(query, signal());
  expect(result).toMatchObject({ status: 'error', matches: [], originals: [], partial: true });
  expect(result.metrics).toMatchObject({ requests: 2, estimatedCostUsd: null, unknownRequests: 1 });
  expect(result.metrics.knownEstimatedCostUsd).toBeCloseTo(0.000042, 10);
});

test('cached low scores do not hide newly appended corrections', async () => {
  const f = await fixture();
  f.threads.set('current', thread('current', ['irrelevant']));
  expect((await f.recall.search(query, signal())).matches).toHaveLength(0);
  f.threads.set('current', thread('current', ['irrelevant', '문제를 해결하여 재개했습니다.']));
  expect((await f.recall.search(query, signal())).matches.some(m => m.text.includes('재개'))).toBe(true);
});

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('search follows explicit source IDs outside the evaluated page without another model call', async () => {
  let calls = 0;
  const f = await fixture(async (_query, candidates, _signal, onUsage) => {
    calls++;
    expect(candidates.some(p => p.text.includes('직접 만든 기능'))).toBe(false);
    onUsage?.(recallResponseUsage({ model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 50 } }, 5));
    return candidates.map(p => ({ answer: p.text.includes('출처') ? 0.9 : 0, related: 0, direct: 0.1 }));
  });
  f.threads.set('current', thread('current', [...Array.from({ length: 30 }, (_, i) => `Aside 진행 ${i}`),
    'Aside 출처: `past` / `turn-0` / `message-0`']));
  f.threads.set('past', thread('past', ['직접 만든 기능은 Autopilot입니다.']));
  const result = await f.recall.search({ query: 'Aside', threadId: 'current' }, signal());
  expect(result.originals[0]).toMatchObject({ threadId: 'past', turnId: 'turn-0', itemId: 'message-0',
    text: '직접 만든 기능은 Autopilot입니다.', retrievedVia: { threadId: 'current', turnId: 'turn-30', itemId: 'message-30' } });
  expect(result.originals[0]).not.toHaveProperty('answerScore');
  expect(result.unresolvedReferences).toBe(0);
  expect(calls).toBe(1);
  expect(result.metrics.requests).toBe(1);
  expect(result.metrics.estimatedCostUsd).toBeCloseTo(0.000042, 10);
  expect(f.reads).toEqual(['current', 'past', 'current', 'past']);
});

test.each(['thread', 'focus', 'ordinal'])('citation expansion respects the selected boundary: %s', async boundary => {
  const f = await fixture(async (_q, candidates) => candidates.map(() => ({ answer: 0.9, related: 0.8, direct: 0.1 })));
  f.threads.set('current', thread('current', ['older target', '출처: past turn-0 message-0; current turn-0 message-0']));
  f.threads.set('past', thread('past', ['outside target']));
  const args = boundary === 'thread' ? { scope: 'thread' } : {
    scope: 'workspace', focusThreadId: 'current', ...(boundary === 'ordinal' ? { afterOrdinal: 0 } : {}),
  };
  const result = await f.recall.search({ query: '출처', threadId: 'current', ...args }, signal());
  expect(result.originals.every(p => p.threadId === 'current')).toBe(true);
  if (boundary === 'ordinal') expect(result.originals.every(p => p.ordinal > 0)).toBe(true);
  expect(f.reads.every(id => id === 'current')).toBe(true);
});

test.each(['missing-thread', 'mismatched-turn', 'substring'])('unresolvable citation IDs never fabricate a linked original: %s', async mode => {
  const f = await fixture(async (_q, candidates) => candidates.map(p => ({ answer: p.text.includes('出典') ? 0.9 : 0, related: 0, direct: 0.1 })));
  const ids = mode === 'missing-thread' ? 'turn-0 message-0' : mode === 'mismatched-turn'
    ? 'past turn-0 message-1' : 'past-other turn-0 message-0';
  f.threads.set('current', thread('current', [`出典 ${ids}`]));
  f.threads.set('past', thread('past', ['first', 'second']));
  const result = await f.recall.search({ query: '出典', threadId: 'current' }, signal());
  expect(result.originals.map(p => p.threadId)).toEqual(['current']);
});

test.each(['delete', 'unavailable', 'edited'])('linked originals are refreshed after scoring: %s', async mode => {
  const f = await fixture(async (_q, candidates) => {
    if (mode === 'delete') await f.history.remove(['past']);
    if (mode === 'unavailable') f.failed.add('past');
    if (mode === 'edited') f.threads.set('past', thread('past', ['updated source']));
    return candidates.map(p => ({ answer: p.text.includes('출처') ? 0.9 : 0, related: 0, direct: 0.1 }));
  });
  f.threads.set('current', thread('current', [...Array.from({ length: 30 }, (_, i) => `Aside ${i}`),
    'Aside 출처 past turn-0 message-0']));
  f.threads.set('past', thread('past', ['old source']));
  const result = await f.recall.search({ query: 'Aside', threadId: 'current' }, signal());
  expect(result.originals.some(p => p.text === 'old source')).toBe(false);
  if (mode === 'edited') expect(result.originals[0]?.text).toBe('updated source');
  else {
    expect(result.originals.every(p => p.threadId !== 'past')).toBe(true);
    expect(result.unresolvedReferences).toBe(1);
    expect(result.partial).toBe(true);
  }
});

test('citation expansion is capped, deduplicated and does not recursively follow sources', async () => {
  const f = await fixture(async (_q, candidates) => candidates.map(p => ({ answer: p.text.includes('Aside') ? 0.9 : 0, related: 0, direct: 0.1 })));
  f.threads.set('current', thread('current', ['Aside 出典 past turn-0 message-0 turn-1 message-1 turn-2 message-2 turn-3 message-3',
    'Aside duplicate 出典 past turn-0 message-0']));
  f.threads.set('past', thread('past', ['nested turn-0 message-0', 'second', 'third', 'fourth']));
  f.threads.set('nested', thread('nested', ['recursively cited']));
  const result = await f.recall.search({ query: 'Aside', threadId: 'current' }, signal());
  expect(result.originals.map(p => [p.threadId, p.itemId])).toEqual([
    ['past', 'message-0'], ['past', 'message-1'], ['past', 'message-2'],
  ]);
  expect(result.originals.every(p => p.text.length <= 4000 && p.retrievedVia?.threadId === 'current')).toBe(true);
});

test('repeated recall answers cannot monopolize a page and pagination retains every candidate once', async () => {
  const seen: string[] = [];
  const f = await fixture(async (_query, candidates) => {
    seen.push(...candidates.map(p => p.id));
    return candidates.map(p => ({ answer: 0.9, related: 0.8, direct: p.text.includes('직접 구현') ? 0.95 : 0.1 }));
  });
  f.threads.set('current', thread('current', Array.from({ length: 50 }, (_, i) => `Aside 기록을 찾았습니다. ${i}`)));
  f.threads.set('Aside 구현', thread('Aside 구현', ['Autopilot을 직접 구현했습니다.']));
  const args = { query: 'Aside', threadId: 'current', scope: 'workspace' };
  let result = await f.recall.search(args, signal());
  expect(result.evaluatedPassages).toBe(24);
  expect(result.originals[0]?.threadId).toBe('Aside 구현');
  while (result.nextOffset !== null) {
    result = await f.recall.search({ ...args, offset: result.nextOffset, snapshot: result.snapshot }, signal());
  }
  expect(seen).toHaveLength(51);
  expect(new Set(seen).size).toBe(51);
});

test('a long repeated message does not crowd another message out of the first page', async () => {
  const seen: string[] = [];
  const f = await fixture(async (_query, candidates) => {
    seen.push(...candidates.map(p => p.text));
    return candidates.map(() => ({ answer: 0.8, related: 0.8, direct: 0.8 }));
  });
  f.threads.set('current', thread('current', ['Autopilot 완료', 'Aside '.repeat(10_000)]));
  const result = await f.recall.search({ query: 'Aside Autopilot', threadId: 'current' }, signal());
  expect(result.evaluatedPassages).toBe(24);
  expect(seen).toContain('Autopilot 완료');
});

test('direct subject evidence and later corrections outrank retellings without promoting unrelated implementation', async () => {
  const judgments = new Map([
    ['당시 Autopilot을 구현했습니다.', { answer: 0.81, related: 0.8, direct: 0.95 }],
    ['이후 Autopilot 지원을 중단했습니다.', { answer: 0.2, related: 0.95, direct: 0.95 }],
    ['Autopilot 기록을 찾아 요약했습니다.', { answer: 0.99, related: 0.99, direct: 0.1 }],
    ['계정 제목 보존을 구현했습니다.', { answer: 0.1, related: 0.1, direct: 0.99 }],
    ['Autopilot 기록을 찾아보겠습니다.', { answer: 0.05, related: 0.1, direct: 0.1 }],
  ]);
  const f = await fixture(async (_query, candidates) => candidates.map(p => judgments.get(p.text)!));
  f.threads.set('current', thread('current', [...judgments.keys()]));
  const result = await f.recall.search({ query: 'Autopilot 구현', threadId: 'current' }, signal());
  expect(result.originals.map(p => p.text)).toEqual([...judgments.keys()].slice(0, 3));
  expect(result.matches.map(p => p.directEvidenceScore)).toEqual([0.95, 0.95, 0.1]);
  expect(result.matches).toHaveLength(3);
});

test('retellings remain available when direct records are missing', async () => {
  const f = await fixture(async (_query, candidates) => candidates.map(() => ({ answer: 0.9, related: 0.8, direct: 0.1 })));
  f.threads.set('current', thread('current', ['과거 기록에서는 자격 증명 문제로 중단했다고 합니다.']));
  const result = await f.recall.search(query, signal());
  expect(result.originals[0]?.text).toContain('자격 증명');
  expect(result.matches[0]?.directEvidenceScore).toBe(0.1);
});

test('a concurrent search expiring cached assessments cannot corrupt an in-flight request', async () => {
  const entered = createDeferred(), release = createDeferred();
  let waitForPast = false;
  const f = await fixture(async (_q, candidates) => {
    if (waitForPast && candidates.some(p => p.text === 'past')) { entered.resolve(); await release.promise; }
    return candidates.map(() => ({ answer: 0.9, related: 0.1, direct: 0.9 }));
  });
  f.threads.set('current', thread('current', ['current']));
  await f.recall.search(query, signal());
  f.threads.set('past', thread('past', ['past']));
  waitForPast = true;
  const pending = f.recall.search({ ...query, scope: 'workspace' }, signal());
  await entered.promise;
  const time = spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
  try {
    await f.recall.search({ ...query, query: 'different query' }, signal());
    release.resolve();
    expect((await pending).matches).toHaveLength(2);
  } finally { release.resolve(); time.mockRestore(); }
});


test('lexical pages do not include zero-overlap conversations but subsequent pages retain semantic recall', async () => {
  const evaluated: string[][] = [];
  const f = await fixture(async (_query, candidates) => {
    evaluated.push(candidates.map(candidate => candidate.title ?? ''));
    return candidates.map(() => ({ answer: 0.9, related: 0.9, direct: 0.9 }));
  });
  f.threads.set('match', thread('match', ['needle original decision']));
  for (let i = 0; i < 6; i++) f.threads.set(`other-${i}`, thread(`other-${i}`, ['different subject']));
  const args = { query: 'needle', threadId: 'current', scope: 'workspace' };
  const first = await f.recall.search(args, signal());
  expect(evaluated).toEqual([['match']]);
  expect(first.nextOffset).toBe(1);
  expect(first.partial).toBe(true);
  const second = await f.recall.search({ ...args, offset: first.nextOffset, snapshot: first.snapshot }, signal());
  expect(evaluated[1]).toHaveLength(6);
  expect(evaluated[1]).not.toContain('match');
  expect(second.nextOffset).toBeNull();
});
