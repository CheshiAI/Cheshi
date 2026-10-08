import { expect, test } from 'bun:test';
import { createLunaSummary, parseMemoryTurns, validateSummary, type SummaryInput } from '../lib/flash/summary.mts';
import { FlashSessionMemory } from '../lib/flash/session-memory.mts';
import { account, deferred, fixtureSummary, flashFixture, history, readRequest, rejection, session } from './flash-test-helpers.ts';
import { createFakeCodexClient } from './codex-chat-test-helpers.ts';

const input: SummaryInput = { question: '배경은?', turns: [{ session_id: 's', turn_id: 't', messages: [
  { session_id: 's', turn_id: 't', source_id: 'q', message_id: 'q', kind: 'user', entry: 0, text: '배경은 어떻게 할까?' },
  { session_id: 's', turn_id: 't', source_id: 'a', message_id: 'a', kind: 'assistant', entry: 2, text: '투명하게 유지합니다. 테두리는 1px입니다.' },
] }] };

test('summaries require exact original quotes and valid sources; insufficient evidence remains explicit', () => {
  const valid = { summary: '투명 배경, 1px 테두리', insufficient_evidence: false, evidence: [{ source_id: 'a', quote: '테두리는 1px입니다.' }] };
  expect(validateSummary(valid, input.turns).evidence[0]).toMatchObject({ session_id: 's', turn_id: 't', source_id: 'a' });
  for (const evidence of [[], [{ source_id: 'unknown', quote: '테두리는 1px입니다.' }], [{ source_id: 'a', quote: '2px' }]]) {
    expect(() => validateSummary({ ...valid, evidence }, input.turns)).toThrow();
  }
  expect(validateSummary({ summary: '근거 부족', insufficient_evidence: true, evidence: [] }, input.turns).insufficient_evidence).toBe(true);
});

function validateQuote(original: string, quote: string, sourceId = 'a') {
  const turns = structuredClone(input.turns);
  turns[0]!.messages[1]!.text = original;
  return validateSummary({ summary: '근거 요약', insufficient_evidence: false,
    evidence: [{ source_id: sourceId, quote }] }, turns).evidence[0]!;
}

test('format-only citation differences restore the original contiguous Markdown passage', () => {
  const cases = [
    ['**맡긴 일을 계속 진행하는 개인 AI 에이전트**예요. [안내](https://example.com)',
      '맡긴 일을 계속 진행하는 개인 AI 에이전트예요.', '**맡긴 일을 계속 진행하는 개인 AI 에이전트**예요.'],
    ['앞 문장. 배경은 **투명**, 테두리는 **1px**입니다. 뒷 문장.',
      '배경은 투명, 테두리는 1px입니다.', '배경은 **투명**, 테두리는 **1px**입니다.'],
    ['**배경은 투명**하게 유지합니다.', '**배경은 투명하게 유지합니다.**', '**배경은 투명**하게 유지합니다.'],
    ['**투명** 배경을 유지합니다.', '투명 배경을 유지합니다.', '**투명** 배경을 유지합니다.'],
    ['__Transparent__ background.', 'Transparent background.', '__Transparent__ background.'],
    ['배경은 투명하게 유지합니다.', '**배경은 투명하게** 유지합니다.', '배경은 투명하게 유지합니다.'],
    ['🙂 **투명 배경**입니다.\n테두리는 **1px**입니다.',
      '🙂 투명 배경입니다.\n테두리는 1px입니다.', '🙂 **투명 배경**입니다.\n테두리는 **1px**입니다.'],
  ];
  for (const [original, quote, expected] of cases) {
    const result = validateQuote(original!, quote!);
    expect(result.quote).toBe(expected!);
    expect(original!.includes(result.quote)).toBe(true);
    expect(result).toMatchObject({ source_id: 'a', message_id: 'a', session_id: 's', turn_id: 't' });
  }
});

test('format restoration never changes numbers, negation, punctuation, case or whitespace', () => {
  const original = '**메모리는 1024MB**, 배경은 투명하지 않습니다.';
  for (const quote of [
    '메모리는 512MB, 배경은 투명하지 않습니다.',
    '메모리는 1024MB, 배경은 투명합니다.',
    '메모리는 1024MB. 배경은 투명하지 않습니다.',
    '메모리는 1024mb, 배경은 투명하지 않습니다.',
    '메모리는 1024MB,  배경은 투명하지 않습니다.',
  ]) expect(() => validateQuote(original, quote)).toThrow('Summary citation does not match the original');
  expect(() => validateQuote(original, '메모리는 1024MB, 배경은 투명하지 않습니다.', 'unknown')).toThrow();
  expect(() => validateQuote(original, '배경은 투명하게 유지합니다.', 'q')).toThrow();
});

test('ambiguous normalized matches and content-bearing Markdown remain rejected', () => {
  const cases = [
    ['**값**입니다. **값**입니다.', '값입니다.'],
    ['~~1024MB~~ → 512MB', '1024MB → 512MB'],
    ['값은 **설정 안 함**입니다.', '값은 설정함입니다.'],
    ['값은 **설정**입니다. 중간 내용. **완료**입니다.', '값은 설정입니다. 완료입니다.'],
    ['[설정](https://example.com/**값**입니다.)', 'https://example.com/값입니다.'],
    ['값은 **미완성입니다.', '값은 미완성입니다.'],
    ['\\**값**입니다.', '값입니다.'],
    ['값은 `**그대로**입니다.`', '그대로입니다.'],
    ['```md\n**값**입니다.\n```', '값입니다.'],
    ['~~~md\n**값**입니다.\n~~~', '값입니다.'],
    ['    **값**입니다.', '값입니다.'],
    ['> ```\n> **값**입니다.\n> ```', '값입니다.'],
    ['<pre>\n**값**입니다.\n</pre>', '값입니다.'],
    ['$2**3**4$', '234'],
    ['2**3**4', '234'],
  ];
  for (const [original, quote] of cases) expect(() => validateQuote(original!, quote!)).toThrow();
  // Exact raw quotations still work inside code and other protected syntax.
  expect(validateQuote('```\n**값**입니다.\n```', '**값**입니다.').quote).toBe('**값**입니다.');
});

test('restored quotes do not relax summary schema validation or hide another bad citation', () => {
  const turns = structuredClone(input.turns);
  turns[0]!.messages[1]!.text = '**배경은 투명**합니다.';
  const summary = { summary: '투명 배경', insufficient_evidence: false,
    evidence: [{ source_id: 'a', quote: '배경은 투명합니다.' }] };
  expect(() => validateSummary({ ...summary, insufficient_evidence: 'false' }, turns)).toThrow();
  expect(() => validateSummary({ ...summary, evidence: [...summary.evidence, { source_id: 'a', quote: '불투명합니다.' }] }, turns)).toThrow();
});

test('turn responses cannot be partial, unordered or from a different session', () => {
  const messages = input.turns[0]!.messages.map(item => ({ ...item, offset: 0, next_offset: null, total_characters: [...item.text].length }));
  const ref = { session_id: 's', turn_id: 't' };
  expect(parseMemoryTurns({ turns: [{ ...ref, messages }] }, [ref])).toEqual(input.turns);
  for (const changed of [messages.toReversed(), [{ ...messages[0], next_offset: 1 }], [{ ...messages[0], session_id: 'other' }]]) {
    expect(() => parseMemoryTurns({ turns: [{ ...ref, messages: changed }] }, [ref])).toThrow();
  }
});

test('oversized full turns fail before starting a provider session, without truncation', async () => {
  const summarize = createLunaSummary(() => { throw new Error('Provider must not start'); }, '/workspace');
  const large = structuredClone(input);
  large.turns[0]!.messages[0]!.text = 'x'.repeat(128000);
  const error = await rejection(() => summarize(large, new AbortController().signal));
  expect(error).toMatchObject({ code: 'turns_too_large' });
  expect(large.turns[0]!.messages[0]!.text).toHaveLength(128000);
});

test('Luna receives only the selected turns and question in a minimal tool-free temporary session', async () => {
  const started = deferred<void>();
  const client = createFakeCodexClient({
    'account/read': { account: { type: 'chatgpt' } }, 'config/read': { config: {} },
    'model/list': { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'Luna', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] },
    'thread/start': { thread: { id: 'temporary', ephemeral: true }, model: 'gpt-6-luna', modelProvider: 'openai' },
    'turn/start': () => { started.resolve(); return { turn: { id: 'summary-turn' } }; },
    'thread/unsubscribe': {},
  });
  let stopped = false;
  const summarize = createLunaSummary(() => ({ ...client, stop: async () => { stopped = true; } }), '/workspace');
  const pending = summarize(input, new AbortController().signal);
  await started.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  client.emit('turn/completed', { threadId: 'temporary', turn: { id: 'summary-turn', status: 'completed', items: [
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(await fixtureSummary(input)) },
  ] } });
  expect(await pending).toEqual(await fixtureSummary(input));
  const start = client.requests.find(item => item.method === 'thread/start')!.params;
  expect(start).toMatchObject({ model: 'gpt-6-luna', ephemeral: true, developerInstructions: '', dynamicTools: [], config: {
    project_doc_max_bytes: 0, 'memories.use_memories': false, 'features.apps': false, 'features.plugins': false,
  } });
  const turn = client.requests.find(item => item.method === 'turn/start')!.params;
  expect(turn).toMatchObject({ effort: 'low', input: [{ type: 'text', text: JSON.stringify(input) }] });
  expect(stopped).toBe(true);
});

test('complete ordered question and answer reach the summarizer; Flash remains free during inference', async () => {
  const f = await flashFixture();
  const entered = deferred<SummaryInput>(); const finish = deferred<void>();
  const raw = { thread: { id: 's', cwd: '/workspace', turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'q', type: 'userMessage', content: [{ type: 'text', text: '배경은 어떻게 할까?' }] },
    { id: 'tool', type: 'commandExecution', command: 'private log' },
    { id: 'a', type: 'agentMessage', text: '투명하게 유지합니다.' },
  ] }] } };
  const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
    source: { list: async () => ({ sessions: [session()] }), read: async () => raw },
    summarize: async value => { entered.resolve(value); await finish.promise; return fixtureSummary(value); } });
  memory.accounts(account());
  try {
    const pending = memory.execute('memory_read', readRequest(), 'caller', new AbortController().signal);
    const received = await entered.promise;
    expect(received.turns[0]!.messages.map(item => [item.kind, item.text])).toEqual([
      ['user', '배경은 어떻게 할까?'], ['assistant', '투명하게 유지합니다.'],
    ]);
    expect(f.grants.size).toBe(0);
    await memory.synchronize();
    await memory.execute('memory_search', { query: '배경' }, 'caller', new AbortController().signal);
    finish.resolve();
    expect(await pending).toMatchObject({ insufficient_evidence: false, model: 'gpt-6-luna' });
  } finally { finish.resolve(); await memory.dispose(); await f.close(); }
});

for (const change of ['cancel', 'disconnect', 'edit', 'append', 'delete', 'provider-error'] as const) {
  test(`a ${change} during Luna inference never publishes stale evidence`, async () => {
    const f = await flashFixture();
    const entered = deferred<void>(); const finish = deferred<void>();
    let raw = history(); let sessions = [session()];
    const caller = new AbortController();
    const memory = new FlashSessionMemory({ workspace: '/workspace', host: f.host,
      source: { list: async () => ({ sessions }), read: async () => raw },
      summarize: async value => { entered.resolve(); await finish.promise;
        if (change === 'provider-error') throw new Error('Provider failed');
        return fixtureSummary(value); } });
    memory.accounts({ activeId: 'a', profiles: [...account('a').profiles, ...account('b').profiles] });
    try {
      const pending = rejection(() => memory.execute('memory_read', readRequest(), 'caller', caller.signal));
      await entered.promise;
      if (change === 'cancel') caller.abort();
      if (change === 'disconnect') memory.accounts(account());
      if (change === 'edit') raw = history('Edited while summarizing');
      if (change === 'append') raw.thread.turns[0]!.items.push({ id: 'added', type: 'agentMessage', text: 'Later correction' });
      if (change === 'delete') sessions = [];
      finish.resolve();
      expect(await pending).toBeInstanceOf(Error);
      expect(f.grants.size).toBe(0);
    } finally { finish.resolve(); await memory.dispose(); await f.close(); }
  });
}
