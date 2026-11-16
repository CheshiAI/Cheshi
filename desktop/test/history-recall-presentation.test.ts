import { expect, test } from 'bun:test';
import { activityFromItem, timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { normalizeTimelineItem } from '../frontend/src/features/chat/model';

const source = { threadId: 'past', turnId: 'turn', itemId: 'message', title: 'Past decision', text: 'Original source text' };
const metrics = { requests: 1, estimatedCostUsd: 0.01 };
const item = { id: 'tool-1', type: 'mcpToolCall', server: 'cheshi_history', tool: 'history_search', status: 'completed',
  result: { content: [{ type: 'text', text: JSON.stringify({ historyRecallVersion: 1, metrics, matches: [source] }) }] } };

test('live and saved legacy recall calls remain ordinary tool records without source display metadata', () => {
  const live = activityFromItem(item, 'completed', item.id);
  const saved = timelineFromThread({ id: 'current', turns: [{ id: 'turn', status: 'completed', items: [item] }] });
  for (const value of [live, ...saved]) {
    expect(value).toMatchObject({ kind: 'activity', label: 'history_search', detail: 'cheshi_history', status: 'completed' });
    expect(value).not.toHaveProperty('recall');
    expect(normalizeTimelineItem(value)).not.toHaveProperty('recall');
  }
});

test('renderer drops legacy recall fields restored from an older cache', () => {
  const legacy = { ...activityFromItem(item, 'completed', item.id),
    recall: { operation: 'search', status: 'candidates', sources: [source], metrics } };
  expect(normalizeTimelineItem(legacy)).not.toHaveProperty('recall');
});
