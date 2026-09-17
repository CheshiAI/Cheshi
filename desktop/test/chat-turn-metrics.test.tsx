import { expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { normalizeTurnMetricsResponse, type ChatTurnMetrics } from '../shared/chat-turn-metrics';

const calls: unknown[] = [];
let read: (threadId: string) => Promise<unknown>;
mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: {
  readCodexTurnMetrics(threadId: string, contextId?: string) { calls.push([threadId, contextId]); return read(threadId); },
} }));
const { ChatTurnMetricsProvider, ChatTurnMetrics: Statistics, TurnMetricsSummary } = await import('../frontend/src/features/chat/ChatTurnMetrics');

const metrics: ChatTurnMetrics = { turnId: 'turn', itemIds: ['answer'], agentName: 'Main agent', model: 'gpt-6-astra',
  reasoningEffort: 'high', usage: { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 0,
    outputTokens: 600, reasoningOutputTokens: 100, totalTokens: 1600 }, durationMs: 2000 };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('English response statistics show turn usage, cache share and average TPS without counting reasoning twice', () => {
  const html = renderToStaticMarkup(<TurnMetricsSummary metrics={metrics} />);
  for (const text of ['Main agent', 'gpt-6-astra', 'high', '1,000', '800', '80.0%', 'Avg TPS:', '300.0', '2.0s']) expect(html).toContain(text);
  expect(html).toContain('Reasoning (within output)');
  expect(renderToStaticMarkup(<TurnMetricsSummary />)).toContain('Not available');
  expect(renderToStaticMarkup(<TurnMetricsSummary metrics={{ ...metrics, durationMs: 0 }} />)).not.toContain('Infinity');
});

test('normalization rejects cross-conversation metrics and invalid counters remain unknown', () => {
  expect(() => normalizeTurnMetricsResponse({ threadId: 'other', turns: [metrics] }, 'root')).toThrow('another conversation');
  expect(() => normalizeTurnMetricsResponse({ threadId: 'root', turns: [{ ...metrics, itemIds: [1] }] }, 'root')).toThrow('identity');
  const parsed = normalizeTurnMetricsResponse({ threadId: 'root', turns: [{ ...metrics, durationMs: -1, usage: { ...metrics.usage, outputTokens: -1 } }] }, 'root');
  expect(parsed.turns[0]).toMatchObject({ durationMs: null, usage: null });
});

test('only completed active views load statistics, preserve older rows during streaming and discard late previous-session results', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const gate = createDeferred<unknown>();
  read = async id => id === 'slow' ? gate.promise : { threadId: id, turns: [{ ...metrics, agentName: id }] };
  calls.length = 0;
  const render = (threadId: string, streaming: boolean, active = true) => <ChatTurnMetricsProvider key={threadId}
    threadId={threadId} contextId="pane-b" active={active} streaming={streaming} expectedItemId="answer"><Statistics itemId="answer" /></ChatTurnMetricsProvider>;
  try {
    await act(async () => root.render(render('root', true)));
    expect(calls).toHaveLength(0);
    await act(async () => root.render(render('root', false, false)));
    expect(calls).toHaveLength(0);
    await act(async () => root.render(render('root', false)));
    expect(calls).toEqual([['root', 'pane-b']]);
    expect(container.textContent).toContain('Avg TPS: 300.0');
    await act(async () => root.render(render('root', true)));
    expect(container.textContent).toContain('Avg TPS: 300.0');
    expect(calls).toHaveLength(1);
    await act(async () => root.render(render('slow', false)));
    await act(async () => root.render(render('next', false)));
    await act(async () => gate.resolve({ threadId: 'slow', turns: [{ ...metrics, agentName: 'Stale agent' }] }));
    expect(container.textContent).toContain('Agent: next');
    expect(container.textContent).not.toContain('Stale agent');
    let attempts = 0;
    read = async id => ({ threadId: id, turns: [{ ...metrics, itemIds: [++attempts === 1 ? 'previous-answer' : 'answer'] }] });
    await act(async () => root.render(render('flushed', false)));
    expect(container.textContent).toContain('Avg TPS: Not available');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 850)); });
    expect(attempts).toBe(2);
    expect(container.textContent).toContain('Avg TPS: 300.0');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
