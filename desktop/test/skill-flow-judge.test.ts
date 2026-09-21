import { expect, test } from 'bun:test';
import { createSkillFlowJudge, SKILL_FLOW_REQUEST_BYTES, type SkillFlowFetch } from '../lib/skill-flow-judge.mts';

const question = { state: { research: '조사를 마쳤습니다.' }, condition: '조사가 끝났는가?' };

function answer(choice: unknown, type = 'choice'): Response {
  return Response.json({ model: 'test-model', answers: { condition: { type, choice } },
    usage: { input_tokens: 120, output_tokens: 4 } });
}

test.each([['yes', true], ['no', false]] as const)('follows Jev choice %s as literal %s', async (choice, value) => {
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => answer(choice) });
  expect(await judge(question)).toMatchObject({ choice, status: 'decided', value });
});

// Deliberately conflicting metadata proves that only the selected option controls the branch.
test.each(['yes', 'no'] as const)('ignores numeric metadata when Jev selects %s', async choice => {
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => Response.json({
    answers: { condition: { type: 'choice', choice, confidence: 0,
      probabilities: choice === 'yes' ? { yes: 0, no: 1 } : { yes: 1, no: 0 } } },
  }) });
  const result = await judge(question);
  expect(result).toMatchObject({ choice, value: choice === 'yes' });
  for (const field of ['probability', 'probabilities', 'confidence', 'threshold']) expect(result).not.toHaveProperty(field);
});

test('sends the supplied state and natural-language condition through the documented Choice contract', async () => {
  let calls = 0;
  const request: SkillFlowFetch = async (url, init) => {
    calls++;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-only');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({ model: 'jev-latest', state: question.state,
      questions: { condition: { type: 'choice', instructions: question.condition, criteria: {
        yes: '조건이 충족됩니다.', no: '조건이 충족되지 않습니다.',
      } } } });
    return answer('yes');
  };
  const result = await createSkillFlowJudge({ getKey: () => 'test-only', request })(question);
  expect(calls).toBe(1);
  expect(result).toMatchObject({ model: 'test-model', inputTokens: 120, outputTokens: 4 });
});

test.each([undefined, null, 'maybe', true, 1, 'YES', ''])('malformed choice %s never passes', async value => {
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => answer(value) });
  expect(await judge(question)).toMatchObject({ status: 'error', value: null, reason: 'invalid_response' });
});

test('rejects a different answer type and missing answer even with successful HTTP', async () => {
  for (const response of [answer('yes', 'noul'), Response.json({ answers: {} }), new Response('not json')]) {
    const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => response });
    expect(await judge(question)).toMatchObject({ status: 'error', value: null, reason: 'invalid_response' });
  }
});

test('missing or inaccessible credentials make no request and do not expose error details', async () => {
  let calls = 0;
  const request: SkillFlowFetch = async () => { calls++; return answer('yes'); };
  const noKey = createSkillFlowJudge({ getKey: () => null, request });
  expect(await noKey(question)).toMatchObject({ reason: 'missing_key', value: null });
  const locked = createSkillFlowJudge({ getKey: () => { throw new Error('private credential'); }, request });
  const result = await locked(question);
  expect(result).toMatchObject({ reason: 'key_unavailable', value: null });
  expect(JSON.stringify(result)).not.toContain('private credential');
  expect(calls).toBe(0);
});

test.each([401, 402, 429, 503])('HTTP %s is an error, with no retry or false judgment', async status => {
  let calls = 0;
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => {
    calls++;
    return new Response('private provider body', { status });
  } });
  const result = await judge(question);
  expect(result).toMatchObject({ status: 'error', value: null, choice: null, reason: 'http', httpStatus: status });
  expect(JSON.stringify(result)).not.toContain('private provider body');
  expect(calls).toBe(1);
});

test('network failure has its own state and unknown usage', async () => {
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => { throw new Error('private URL'); } });
  const result = await judge(question);
  expect(result).toMatchObject({ status: 'error', reason: 'network', inputTokens: null, outputTokens: null });
  expect(JSON.stringify(result)).not.toContain('private URL');
});

test('timeout aborts a pending request and stays distinct from a false judgment', async () => {
  let aborted = false;
  const request: SkillFlowFetch = async (_url, init) => new Promise((_resolve, reject) => {
    // A referenced timer keeps Node alive while the timeout signal is unreferenced.
    const timer = setTimeout(() => reject(new Error('test transport did not abort')), 1_000);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      aborted = true;
      reject(init.signal?.reason);
    }, { once: true });
  });
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', timeoutMs: 10, request });
  expect(await judge(question)).toMatchObject({ status: 'error', reason: 'timeout', value: null });
  expect(aborted).toBe(true);
});

test('timeout covers response body reading, not just receiving headers', async () => {
  const request: SkillFlowFetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      const timer = setTimeout(() => controller.error(new Error('test body did not abort')), 1_000);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        controller.error(init.signal?.reason);
      }, { once: true });
    },
  }));
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', timeoutMs: 10, request });
  expect(await judge(question)).toMatchObject({ status: 'error', reason: 'timeout', value: null });
});

test('caller cancellation is honored both before and during a request', async () => {
  let calls = 0;
  const controller = new AbortController();
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => {
    calls++;
    controller.abort();
    return answer('yes');
  } });
  expect(await judge(question, controller.signal)).toMatchObject({ reason: 'canceled', value: null });
  expect(await judge(question, controller.signal)).toMatchObject({ reason: 'canceled', value: null });
  expect(calls).toBe(1);
});

test('invalid input is rejected before requests, including oversized UTF-8 state', async () => {
  let calls = 0;
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => { calls++; return answer('yes'); } });
  for (const invalid of [{ ...question, condition: '' }, { ...question, state: '한'.repeat(SKILL_FLOW_REQUEST_BYTES / 2) }]) {
    expect(await judge(invalid)).toMatchObject({ status: 'error', reason: 'invalid_input' });
  }
  expect(calls).toBe(0);
});


test('missing usage remains unknown even when the judgment is usable', async () => {
  const judge = createSkillFlowJudge({ getKey: () => 'test-only', request: async () => Response.json({
    answers: { condition: { type: 'choice', choice: 'yes' } },
  }) });
  expect(await judge(question)).toMatchObject({ value: true, model: null, inputTokens: null, outputTokens: null });
});
