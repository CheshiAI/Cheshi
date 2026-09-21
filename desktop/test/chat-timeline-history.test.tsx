import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { captureChatHistoryAnchor, previousChatHistoryStart } from '../frontend/src/features/chat/chatHistoryWindow';
import { completedChatTurnInputs } from '../frontend/src/features/chat/chatTurnSnapshots';
import type { ChatTimelineItem as TimelineItem } from '../frontend/src/features/chat/model';
import type { SavedChatTurnsController } from '../frontend/src/features/chat/useSavedChatTurns';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ChatTimelineHistory } = await import('../frontend/src/features/chat/ChatTimelineHistory');

function history(count: number): TimelineItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`, kind: index % 2 === 0 ? 'user' : 'assistant', createdAt: 1,
    text: `Message ${index}\n\n## Result\n\n| File | Status |\n|---|---|\n| **source.ts** | Ready |\n\n- Check behavior\n- Preserve history\n\n\`\`\`ts\nconst result = true;\n\`\`\``,
  }));
}

function renderHistory(items: TimelineItem[], streaming = false) {
  return renderToStaticMarkup(<ChatTimelineHistory items={items} timelineRef={{ current: null }} loading={false}
    streaming={streaming} completedTurns={completedChatTurnInputs(items, 'thread', 'History', streaming)}
    onReviewFileChanges={() => {}} />);
}

describe('progressive chat history', () => {
  test('initially mounts only the latest 30 items, with complete Markdown', () => {
    const html = renderHistory(history(1000));
    expect(html.match(/data-chat-item-id=/g)).toHaveLength(30);
    expect(html).toContain('data-chat-item-id="item-970"');
    expect(html).toContain('data-chat-item-id="item-999"');
    expect(html).not.toContain('data-chat-item-id="item-969"');
    expect(html).toContain('Show earlier messages');
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>source.ts</strong>');
  });

  test('shows all short conversations and handles empty history', () => {
    expect(renderHistory([])).not.toContain('Show earlier messages');
    for (const length of [1, 29, 30]) {
      const html = renderHistory(history(length));
      expect(html.match(/data-chat-item-id=/g)).toHaveLength(length);
      expect(html).not.toContain('Show earlier messages');
    }
  });

  test('reveals earlier history in batches without skipping or duplicating items', () => {
    const items = history(101);
    let start = previousChatHistoryStart(items.length);
    const ids = items.slice(start).map((item) => item.id);
    while (start > 0) {
      const earlier = previousChatHistoryStart(start);
      expect(start - earlier).toBeLessThanOrEqual(30);
      ids.unshift(...items.slice(earlier, start).map((item) => item.id));
      start = earlier;
    }
    expect(ids).toEqual(items.map((item) => item.id));
    expect(previousChatHistoryStart(0)).toBe(0);
  });

  test('keeps full response snapshots even when their beginning is outside the mounted range', () => {
    const items: TimelineItem[] = history(1);
    for (let index = 1; index <= 60; index += 1) {
      items.push({ id: `item-${index}`, kind: 'assistant', createdAt: 1, text: `Part ${index}` });
    }
    const turns = completedChatTurnInputs(items, 'thread', 'History', false);
    expect(turns.get('item-60')?.assistantText).toContain('Part 1\n\nPart 2');
    expect(turns.get('item-60')?.assistantText).toEndWith('Part 60');
    expect(renderHistory(items)).not.toContain('data-chat-item-id="item-1"');
    expect(completedChatTurnInputs(items, 'thread', 'History', true).size).toBe(0);
  });

  test('keeps the latest reasoning item expanded while streaming', () => {
    const items = history(100);
    items.push({ id: 'reasoning', kind: 'reasoning', createdAt: 1, text: 'Working through the next step' });
    expect(renderHistory(items, true)).toMatch(/<details[^>]*open=""/);
    expect(renderHistory(items, false)).not.toMatch(/<details[^>]*open=""/);
  });
});

describe('history scroll anchoring', () => {
  test('restores the retained row after prepending history', () => {
    const timeline = { scrollTop: 100 };
    let top = 50;
    const restore = captureChatHistoryAnchor(timeline, { isConnected: true, getBoundingClientRect: () => ({ top }) });
    top += 600;
    restore();
    expect(timeline.scrollTop).toBe(700);
  });

  test('does not double compensate when the browser already anchored the row', () => {
    const timeline = { scrollTop: 100 };
    const restore = captureChatHistoryAnchor(timeline, { isConnected: true, getBoundingClientRect: () => ({ top: 50 }) });
    timeline.scrollTop += 600;
    restore();
    expect(timeline.scrollTop).toBe(700);
  });

  test('ignores an anchor removed by a session change', () => {
    const timeline = { scrollTop: 100 };
    const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: 50 }) };
    const restore = captureChatHistoryAnchor(timeline, anchor);
    anchor.isConnected = false;
    restore();
    expect(timeline.scrollTop).toBe(100);
  });
});

describe('turn recall usage placement', () => {
  const usageSummaryLabel = 'History search · Jev estimated';
  const countUsageSummaries = (html: string) => html.split(usageSummaryLabel).length - 1;
  const savedTurns: SavedChatTurnsController = {
    records: [], loading: false, error: null, deleting: false,
    refresh: async () => {}, save: async () => true, remove: async () => true,
    isSaved: () => false, isSaving: () => false, dismissError() {},
  };
  const recall: TimelineItem = {
    id: 'recall', kind: 'activity', activity: 'tool', label: 'History search', detail: '', status: 'completed',
    recall: { operation: 'search', status: 'candidates', partial: false, query: 'Previous decision', sources: [], error: null,
      metrics: { requests: 2, inputTokens: 1000, outputTokens: 50, estimatedCostUsd: 0.000042,
        knownEstimatedCostUsd: 0.000042, unknownRequests: 0, modelMs: 100, totalMs: 200, cacheHits: 0 } },
  };
  function render(items: TimelineItem[], streaming = false, actions = true) {
    return renderToStaticMarkup(<ChatTimelineHistory items={items} timelineRef={{ current: null }} loading={false}
      streaming={streaming} completedTurns={completedChatTurnInputs(items, 'thread', 'History', streaming)}
      savedTurns={actions ? savedTurns : undefined} onReviewFileChanges={() => {}} />);
  }

  function row(html: string, id: string): string {
    return html.split('data-chat-item-id="').find(part => part.startsWith(`${id}"`)) ?? '';
  }

  test('keeps usage beneath the answer that searched when later turns have no search', () => {
    const messages = history(4);
    const html = render([messages[0]!, recall, ...messages.slice(1)]);
    const answer = row(html, 'item-1');
    expect(countUsageSummaries(html)).toBe(1);
    expect(answer).toContain('estimated $0.00004200 USD · 2 requests');
    expect(answer.indexOf(usageSummaryLabel)).toBeGreaterThan(answer.indexOf('aria-label="Response statistics"'));
    expect(answer.indexOf(usageSummaryLabel)).toBeLessThan(answer.indexOf('aria-label="Response actions"'));
    expect(answer).toContain('Recorded calls in this turn only.');
    expect(row(html, 'item-3')).not.toContain(usageSummaryLabel);
  });

  test('sums multiple searches within each turn without carrying usage into the next turn', () => {
    const messages = history(6);
    const html = render([messages[0]!, recall, { ...recall, id: 'call-two' }, messages[1]!,
      messages[2]!, { ...recall, id: 'call-three' }, ...messages.slice(3)]);
    expect(countUsageSummaries(html)).toBe(2);
    expect(row(html, 'item-1')).toContain('estimated $0.00008400 USD · 4 requests');
    expect(row(html, 'item-3')).toContain('estimated $0.00004200 USD · 2 requests');
    expect(row(html, 'item-5')).not.toContain(usageSummaryLabel);
  });

  test('keeps usage in its own turn while streaming or without response controls', () => {
    const messages = history(4);
    const firstTurn = [messages[0]!, recall, messages[1]!];
    for (const html of [render(firstTurn, true), render(firstTurn, false, false),
      render([...firstTurn, ...messages.slice(2)], true)]) {
      expect(countUsageSummaries(html)).toBe(1);
      expect(row(html, 'item-1')).toContain('estimated $0.00004200 USD · 2 requests');
      expect(row(html, 'item-3')).not.toContain(usageSummaryLabel);
    }
  });

  test('includes offscreen calls in the same long turn but does not move offscreen turn totals to a later answer', () => {
    const messages = history(2);
    const longTurn: TimelineItem[] = [messages[0]!, recall,
      ...Array.from({ length: 35 }, (_, i): TimelineItem => ({ id: `thinking-${i}`, kind: 'reasoning', text: 'Thinking', createdAt: 3 })),
      messages[1]!];
    const html = render(longTurn);
    expect(html).not.toContain('data-chat-item-id="recall"');
    expect(row(html, 'item-1')).toContain('estimated $0.00004200 USD · 2 requests');
    const later = history(100).map(item => ({ ...item, id: `later-${item.id}` }));
    expect(render([messages[0]!, recall, ...messages.slice(1), ...later])).not.toContain(usageSummaryLabel);
  });

  test('does not add a Jev summary when the conversation has no recorded usage', () => {
    expect(render(history(2))).not.toContain(usageSummaryLabel);
  });
});
