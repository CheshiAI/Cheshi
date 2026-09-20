import { expect, test } from 'bun:test';
import { createHistoryRecallEvaluator, RECALL_REQUEST_BYTES } from '../lib/chat-history-recall-model.mts';
import type { RecallCandidate, RecallFetch } from '../lib/chat-history-recall-model.mts';
import { addRecallUsage, emptyRecallUsage, recallResponseUsage } from '../lib/chat-history-recall-usage.mts';

function candidates(count: number): RecallCandidate[] {
  return Array.from({ length: count }, (_, index) => ({ id: `p_${index}`, text: '한국어😀'.repeat(300), before: '', after: '' }));
}
async function failure(operation: Promise<unknown>, pattern: RegExp) {
  let reason: unknown;
  try { await operation; } catch (error) { reason = error; }
  expect(reason).toBeInstanceOf(Error);
  expect((reason as Error).message).toMatch(pattern);
}

test('batches UTF-8 requests without dropping candidates and keeps independent Noul scores', async () => {
  const seen: string[] = [];
  let calls = 0;
  const request: RecallFetch = async (_url, init) => {
    calls++;
    expect(init?.redirect).toBe('error');
    expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(RECALL_REQUEST_BYTES);
    const body = JSON.parse(String(init?.body));
    seen.push(...body.state.passages.map((item: RecallCandidate) => item.id));
    expect(body.model).toBe('jev-latest');
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, {
      type: 'noul', noul: key.endsWith('_answer') ? 0.9 : key.endsWith('_direct') ? 0.8 : 0.4,
    }])) });
  };
  const evaluate = createHistoryRecallEvaluator({ getKey: () => 'test-only', request });
  const input = candidates(24);
  const result = await evaluate('중단 사유?', input, new AbortController().signal);
  expect(calls).toBeGreaterThan(1);
  expect(seen).toEqual(input.map(item => item.id));
  expect(result).toEqual(input.map(() => ({ answer: 0.9, related: 0.4, direct: 0.8 })));
});

test.each([undefined, -1, 2, '0.9', null])('rejects malformed or missing scores: %s', async value => {
  const request: RecallFetch = async () => Response.json({ answers: { p_0_answer: { type: 'noul', noul: value } } });
  await failure(createHistoryRecallEvaluator({ getKey: () => 'test-only', request })('query', candidates(1), new AbortController().signal), /invalid/);
});

test.each([undefined, -1, 2, '0.9', null])('rejects invalid direct-evidence scores even when relevance is valid: %s', async value => {
  const request: RecallFetch = async () => Response.json({ answers: {
    p_0_answer: { type: 'noul', noul: 0.9 }, p_0_related: { type: 'noul', noul: 0.9 },
    p_0_direct: { type: 'noul', noul: value },
  } });
  await failure(createHistoryRecallEvaluator({ getKey: () => 'test-only', request })('query', candidates(1), new AbortController().signal), /invalid/);
});

test('missing key avoids external requests and errors never echo provider bodies or credentials', async () => {
  let calls = 0;
  const request: RecallFetch = async () => { calls++; return new Response('private provider body test-only', { status: 401 }); };
  await failure(createHistoryRecallEvaluator({ getKey: () => null, request })('query', candidates(1), new AbortController().signal), /Settings/);
  expect(calls).toBe(0);
  await failure(createHistoryRecallEvaluator({ getKey: () => 'test-only', request })('query', candidates(1), new AbortController().signal), /^TypeSafe history search failed \(HTTP 401\)\.$/);
});

test('accounts for every batch using provider tokens including malformed answers', async () => {
  const usage = emptyRecallUsage();
  let requests = 0;
  const request: RecallFetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init.body));
    return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 1234, output_tokens: 12 },
      answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.8 }])) });
  };
  await createHistoryRecallEvaluator({ getKey: () => 'test-only', request })('query', candidates(24), new AbortController().signal,
    value => addRecallUsage(usage, value));
  expect(requests).toBeGreaterThan(1);
  expect(usage.inputTokens).toBe(1234 * requests);
  expect(usage.outputTokens).toBe(12 * requests);
  expect(usage.estimatedCostUsd).toBeCloseTo(1234 * requests * 0.042 / 1_000_000, 12);
  const invalid = emptyRecallUsage();
  await failure(createHistoryRecallEvaluator({ getKey: () => 'test-only', request: async () => Response.json({
    model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 0 }, answers: {},
  }) })('query', candidates(1), new AbortController().signal, value => addRecallUsage(invalid, value)), /invalid/);
  expect(invalid.requests).toBe(1);
  expect(invalid.inputTokens).toBe(10);
});

test.each([undefined, null, -1, '10', 1.5, Number.MAX_SAFE_INTEGER + 1])('unknown or invalid input usage is not zero: %s', input => {
  expect(recallResponseUsage({ model: 'jev-1.13.0', usage: { input_tokens: input, output_tokens: 10 } }, 1))
    .toMatchObject({ inputTokens: null, estimatedCostUsd: null, unknownRequests: 1 });
});

test('unrecognized model versions and mutable aliases are not priced using an unrelated rate', () => {
  for (const model of ['jev-next', 'jev-latest', undefined]) {
    expect(recallResponseUsage({ model, usage: { input_tokens: 10, output_tokens: 0 } }, 1).estimatedCostUsd).toBeNull();
  }
  expect(recallResponseUsage({ model: 'jev-1.13.0', usage: { input_tokens: 0, output_tokens: 0 } }, 1).estimatedCostUsd).toBe(0);
});

test('HTTP and connection failures report an attempted request with unknown cost', async () => {
  for (const request of [async () => new Response('', { status: 429 }), async () => { throw new Error('offline'); }]) {
    const usage = emptyRecallUsage();
    await failure(createHistoryRecallEvaluator({ getKey: () => 'test-only', request })('query', candidates(1), new AbortController().signal,
      value => addRecallUsage(usage, value)), /TypeSafe/);
    expect(usage).toMatchObject({ requests: 1, estimatedCostUsd: null, unknownRequests: 1 });
  }
});

test.each([0, 0.2, 0.5])('valid no-match and low/uncertain scores never invoke Luna: %s', async score => {
  let fallbacks = 0;
  const evaluate = createHistoryRecallEvaluator({ getKey: () => 'test-only',
    request: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: score }])) });
    }, fallback: async () => { fallbacks++; return []; } });
  expect(await evaluate('query', candidates(1), new AbortController().signal)).toEqual([{ answer: score, related: score, direct: score }]);
  expect(fallbacks).toBe(0);
});

test.each([401, 402, 403, 429, 500, 503])('provider HTTP %s invokes fallback once', async status => {
  let fallbacks = 0;
  const expected = [{ answer: 1, related: 1, direct: 1 }];
  const evaluate = createHistoryRecallEvaluator({ getKey: () => 'test-only',
    request: async () => new Response('', { status }), fallback: async () => { fallbacks++; return expected; } });
  expect(await evaluate('query', candidates(1), new AbortController().signal)).toEqual(expected);
  expect(fallbacks).toBe(1);
});

test('missing key falls back, but an empty page makes no provider calls', async () => {
  let fallbacks = 0;
  const evaluate = createHistoryRecallEvaluator({ getKey: () => null, fallback: async () => { fallbacks++; return []; } });
  expect(await evaluate('query', [], new AbortController().signal)).toEqual([]);
  expect(fallbacks).toBe(0);
  await evaluate('query', candidates(1), new AbortController().signal);
  expect(fallbacks).toBe(1);
});

test.each(['network', 'json', 'assessment'])('unusable %s response invokes fallback once', async mode => {
  let fallbacks = 0;
  const evaluate = createHistoryRecallEvaluator({ getKey: () => 'test-only', request: async () => {
    if (mode === 'network') throw new Error('network private details');
    return mode === 'json' ? new Response('invalid json') : Response.json({ answers: {} });
  }, fallback: async () => { fallbacks++; return [{ answer: 0, related: 0, direct: 0 }]; } });
  expect(await evaluate('query', candidates(1), new AbortController().signal)).toEqual([{ answer: 0, related: 0, direct: 0 }]);
  expect(fallbacks).toBe(1);
});

test('caller cancellation never triggers fallback even when Jev fails', async () => {
  let fallbacks = 0;
  const controller = new AbortController();
  const evaluate = createHistoryRecallEvaluator({ getKey: () => 'test-only', request: async () => {
    controller.abort(new Error('caller canceled')); throw new Error('connection closed');
  }, fallback: async () => { fallbacks++; return []; } });
  await failure(evaluate('query', candidates(1), controller.signal), /caller canceled/);
  expect(fallbacks).toBe(0);
});

test('partial batch failure evaluates the entire page once and retains earlier Jev spending', async () => {
  let calls = 0;
  const input = candidates(24), usage = emptyRecallUsage();
  const expected = input.map(() => ({ answer: 0, related: 0.5, direct: 0 }));
  const evaluate = createHistoryRecallEvaluator({ getKey: () => 'test-only', request: async (_url, init) => {
    if (++calls === 2) return new Response('', { status: 429 });
    const body = JSON.parse(String(init.body));
    return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 10 },
      answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 1 }])) });
  }, fallback: async (_query, actual) => { expect(actual).toEqual(input); return expected; } });
  expect(await evaluate('query', input, new AbortController().signal, value => addRecallUsage(usage, value))).toEqual(expected);
  expect(calls).toBe(2);
  expect(usage.requests).toBe(2);
  expect(usage.knownEstimatedCostUsd).toBeGreaterThan(0);
  expect(usage.estimatedCostUsd).toBeNull();
});
