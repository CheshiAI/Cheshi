import { expect, test } from 'bun:test';
import { historyRecallFromMcp, normalizeRecallMetrics } from '../shared/history-recall';
import { activityFromItem, timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { normalizeTimelineItem } from '../frontend/src/features/chat/model';
import { emptyRecallUsage } from '../lib/chat-history-recall-usage.mts';

const source = { threadId: 'past', turnId: 'turn', itemId: 'message', title: 'Aside처럼 구현하기', text: 'Autopilot 구현 완료' };
const payload = { historyRecallVersion: 1, status: 'candidates', query: 'aside', partial: true,
  metrics: { ...emptyRecallUsage(), cacheHits: 1, totalMs: 3 }, matches: [source] };
const item = { id: 'tool-1', type: 'mcpToolCall', server: 'cheshi_history', tool: 'history_search', status: 'completed',
  result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };

test('live and saved MCP results retain identical validated costs and navigable sources through the renderer model', () => {
  const live = normalizeTimelineItem(activityFromItem(item, 'completed', item.id));
  const saved = timelineFromThread({ id: 'current', turns: [{ id: 'turn', status: 'completed', items: [item] }] });
  expect(live?.kind).toBe('activity');
  if (live?.kind !== 'activity') throw new Error('Expected activity');
  expect(live.recall).toMatchObject({ metrics: payload.metrics, sources: [source] });
  const restored = normalizeTimelineItem(saved[0]);
  if (restored?.kind !== 'activity') throw new Error('Expected saved activity');
  expect(restored.recall).toEqual(live.recall);
});

test('unrelated MCP output and malformed or excessive content are ignored', () => {
  expect(historyRecallFromMcp('other', 'history_search', item.result)).toBeNull();
  expect(historyRecallFromMcp('cheshi_history', 'other', item.result)).toBeNull();
  expect(historyRecallFromMcp('cheshi_history', 'history_search', { content: [{ type: 'text', text: '{bad' }] })).toBeNull();
  expect(historyRecallFromMcp('cheshi_history', 'history_search', { content: [{ type: 'text', text: 'x'.repeat(200_001) }] })).toBeNull();
  expect(normalizeRecallMetrics({ ...payload.metrics, requests: -1 })).toBeNull();
  expect(normalizeRecallMetrics({ ...payload.metrics, inputTokens: '12' })?.inputTokens).toBeNull();
});

test('structured output, reads, partial flags and duplicate source fragments are handled consistently', () => {
  const read = historyRecallFromMcp('cheshi_history', 'history_read', { structuredContent: { historyRecallVersion: 1, ...source } });
  expect(read).toMatchObject({ operation: 'read', sources: [source], metrics: null });
  const search = historyRecallFromMcp('cheshi_history', 'history_search', { structuredContent: {
    ...payload, partial: 'true', matches: [source, source, { ...source, itemId: '' }],
  } });
  expect(search?.partial).toBe(false);
  expect(search?.sources).toHaveLength(1);
});

test('unknown usage stays unknown in the display metadata, including partial failures', () => {
  const parsed = historyRecallFromMcp('cheshi_history', 'history_search', { structuredContent: { ...payload,
    status: 'error', error: 'TypeSafe failed', metrics: { ...payload.metrics, requests: 1, unknownRequests: 1,
      inputTokens: null, outputTokens: null, estimatedCostUsd: 0 },
  } });
  expect(parsed?.metrics?.estimatedCostUsd).toBeNull();
  expect(parsed?.error).toBe('TypeSafe failed');
});

test('linked originals remain first and navigable after live and saved result normalization', () => {
  const original = { ...source, itemId: 'original-message', text: 'Actual implementation source',
    retrievedVia: { threadId: source.threadId, turnId: source.turnId, itemId: source.itemId } };
  const result = { content: [{ type: 'text', text: JSON.stringify({ ...payload, originals: [original],
    matches: [source, { ...original, text: 'Short preview' },
      ...Array.from({ length: 6 }, (_, i) => ({ ...source, itemId: `candidate-${i}` }))],
  }) }] };
  const live = historyRecallFromMcp('cheshi_history', 'history_search', result);
  if (!live) throw new Error('Expected live history activity');
  expect(live?.sources).toHaveLength(6);
  expect(live?.sources[0]).toEqual({ ...source, itemId: 'original-message', text: 'Actual implementation source' });
  const saved = timelineFromThread({ id: 'current', turns: [{ id: 'turn', status: 'completed', items: [{ ...item, result }] }] });
  const restored = normalizeTimelineItem(saved[0]);
  if (restored?.kind !== 'activity') throw new Error('Expected saved history activity');
  expect(restored.recall).toEqual(live);
});
