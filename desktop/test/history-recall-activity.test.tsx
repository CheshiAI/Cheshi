import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { HistoryRecallActivity, HistoryRecallNavigation, HistoryRecallTotals, recallTurnMetrics, sumRecallMetrics } from '../frontend/src/features/chat/HistoryRecallActivity';
import type { ChatActivityItem } from '../frontend/src/features/chat/model';
import type { RecallSource } from '../shared/history-recall';

const source: RecallSource = { threadId: 'past', turnId: 'turn', itemId: 'message', title: 'Aside처럼 구현하기', text: '<script>literal source</script>' };
const item: ChatActivityItem = { id: 'call', kind: 'activity', activity: 'tool', label: 'history_search', detail: 'cheshi_history', status: 'completed',
  recall: { operation: 'search', query: 'aside', status: 'candidates', partial: true, error: null, sources: [source], metrics: {
    requests: 2, inputTokens: 3000, outputTokens: 50, estimatedCostUsd: 0.000126, knownEstimatedCostUsd: 0.000126,
    unknownRequests: 0, modelMs: 200, totalMs: 500, cacheHits: 1,
  } } };

test('cards show small USD costs, input usage, timing, partial scope and safely escaped source previews', () => {
  const html = renderToStaticMarkup(<HistoryRecallActivity item={item} />);
  for (const label of ['0.00012600', '3,000', '0.50', '0.20', 'Partial search', 'candidate sources', 'Aside처럼 구현하기', 'Open original message']) {
    expect(html).toContain(label);
  }
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});

test('source previews render Markdown while keeping raw HTML and unsafe links inert', () => {
  const text = [
    '## Implementation', '', '**Autopilot** supports `research`.', '',
    '- First source', '- Second source', '',
    '| Feature | Status |', '| --- | --- |', '| Research | Complete |', '',
    '```ts', 'const ready = true;', '```', '',
    '[Original](https://example.com/source)', '[Unsafe](javascript:alert(1))',
    '<script>alert(1)</script>', '![Preview](https://example.com/image.png)',
  ].join('\n');
  const html = renderToStaticMarkup(<HistoryRecallActivity item={{ ...item,
    recall: { ...item.recall!, sources: [{ ...source, text }] } }} />);
  for (const expected of ['<h2>Implementation</h2>', '<strong>Autopilot</strong>', 'research</code>',
    '<ul>', '<li>First source</li>', '<table>', '<td>Complete</td>', 'const ready = true;',
    'href="https://example.com/source"', '&lt;script&gt;']) expect(html).toContain(expected);
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('<img');
});

test('turn totals do not double count completion updates or turn unknown spending into zero', () => {
  expect(sumRecallMetrics([item, item])?.requests).toBe(2);
  const unknown: ChatActivityItem = { ...item, id: 'unknown', recall: { ...item.recall!, metrics: {
    ...item.recall!.metrics!, requests: 1, inputTokens: null, outputTokens: null, estimatedCostUsd: null,
    knownEstimatedCostUsd: 0, unknownRequests: 1,
  } } };
  const result = sumRecallMetrics([item, unknown]);
  expect(result).toMatchObject({ requests: 3, estimatedCostUsd: null, inputTokens: null, unknownRequests: 1 });
  const html = renderToStaticMarkup(<HistoryRecallTotals metrics={result} />);
  expect(html).toContain('known + unknown');
  expect(html).toContain('Jev cost excludes Codex');
  expect(html).toContain('Recorded calls in this turn only.');
  expect(renderToStaticMarkup(<HistoryRecallTotals metrics={sumRecallMetrics([])} />)).toBe('');
});

test('turn IDs keep interleaved calls and steering in their originating turns', () => {
  const totals = recallTurnMetrics([
    { ...item, turnId: 'first' },
    { ...item, id: 'second-call', turnId: 'second' },
    { id: 'steer', kind: 'user', turnId: 'first', text: 'Also check this', createdAt: 1 },
    { ...item, id: 'another-call', turnId: 'first' },
    { id: 'first-answer', kind: 'assistant', turnId: 'first', text: 'Found it', createdAt: 2 },
    { id: 'second-answer', kind: 'assistant', turnId: 'second', text: 'Other result', createdAt: 3 },
    { id: 'no-search', kind: 'assistant', turnId: 'third', text: 'No search needed', createdAt: 4 },
  ]);
  expect([...totals.keys()]).toEqual(['first-answer', 'second-answer']);
  expect(totals.get('first-answer')).toMatchObject({ requests: 4, inputTokens: 6000 });
  expect(totals.get('second-answer')).toMatchObject({ requests: 2, inputTokens: 3000 });
});

test('untagged calls join the provider turn when its ID arrives later', () => {
  const totals = recallTurnMetrics([
    { id: 'prompt', kind: 'user', text: 'Find this', createdAt: 1 }, item,
    { id: 'answer', turnId: 'turn', kind: 'assistant', text: 'Found', createdAt: 2 },
    { id: 'next', kind: 'user', text: 'Thanks', createdAt: 3 },
    { id: 'next-answer', turnId: 'next-turn', kind: 'assistant', text: 'Done', createdAt: 4 },
  ]);
  expect([...totals.keys()]).toEqual(['answer']);
  expect(totals.get('answer')?.requests).toBe(2);
});

test('source navigation passes exact ids, respects disabled state and reports missing sources', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const opened: Array<Pick<RecallSource, 'threadId' | 'itemId'>> = [];
  const open = async (value: Pick<RecallSource, 'threadId' | 'itemId'>) => { opened.push(value); return false; };
  const render = (disabled: boolean) => <HistoryRecallNavigation.Provider value={{ open, disabled }}>
    <HistoryRecallActivity item={item} />
  </HistoryRecallNavigation.Provider>;
  try {
    await act(async () => root.render(render(true)));
    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => container.querySelector('button')?.click());
    expect(opened).toHaveLength(0);
    await act(async () => root.render(render(false)));
    await act(async () => container.querySelector('button')?.click());
    expect(opened).toEqual([source]);
    expect(container.textContent).toContain('could not be opened');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('Luna fallback totals stay separate, deduplicated and unknown rather than free', () => {
  const fallback: ChatActivityItem = { ...item, recall: { ...item.recall!, metrics: { ...item.recall!.metrics!,
    luna: { requests: 1, inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 10, cachedInputTokens: 0, modelMs: 500 },
  } } };
  const unknown: ChatActivityItem = { ...fallback, id: 'fallback-unknown', recall: { ...fallback.recall!, metrics: {
    ...fallback.recall!.metrics!, luna: { ...fallback.recall!.metrics!.luna!, inputTokens: null },
  } } };
  const totals = sumRecallMetrics([fallback, fallback, unknown]);
  expect(totals).toMatchObject({ requests: 4, inputTokens: 6000,
    luna: { requests: 2, inputTokens: null, outputTokens: 40, reasoningOutputTokens: 20, modelMs: 1000 } });
  const html = renderToStaticMarkup(<HistoryRecallTotals metrics={totals} />);
  expect(html).toContain('Luna low fallback');
  expect(html).toContain('subscription usage cost: Unknown');
  expect(html).toContain('Luna input: Unknown');
});
