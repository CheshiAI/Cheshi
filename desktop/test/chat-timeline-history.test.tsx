import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { captureChatHistoryAnchor, previousChatHistoryStart } from '../frontend/src/features/chat/chatHistoryWindow';
import { completedChatTurnInputs } from '../frontend/src/features/chat/chatTurnSnapshots';
import type { ChatTimelineItem as TimelineItem } from '../frontend/src/features/chat/model';
import { groupReasoningItems, reasoningMarkdown } from '../frontend/src/features/chat/chatReasoningPresentation';

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

  test('renders reasoning Markdown without copy controls during streaming and after completion', () => {
    const items: TimelineItem[] = [{ id: 'reasoning', kind: 'reasoning', createdAt: 1,
      text: '**First summary**\n\nSecond summary\ncontinued\n\n```text\nexample\n```' }];
    for (const streaming of [true, false]) {
      const html = renderHistory(items, streaming);
      expect(html).toContain('aria-label="Reasoning"');
      expect(html).toContain('<strong>First summary</strong>');
      expect(html).toContain('<p>Second summary\ncontinued</p>');
      expect(html).toContain('<pre><code>example\n</code></pre>');
      expect(html).not.toContain('**');
      expect(html).not.toContain('<button');
      expect(html).not.toContain('<details');
    }
  });
});

describe('compact reasoning presentation', () => {
  test('separates legacy joined headings and keeps their item identities in one group', () => {
    const items: TimelineItem[] = [
      { id: 'first', kind: 'reasoning', turnId: 'turn', createdAt: 1, text: '**Computing minimum C****Verifying minimum C**' },
      { id: 'second', kind: 'reasoning', turnId: 'turn', createdAt: 1, text: '**Verifying candidate cases****Checking four candidate pairs**' },
    ];
    const html = renderHistory(items);
    expect(html.match(/data-reasoning-group="true"/g)).toHaveLength(1);
    expect(html.match(/data-chat-item-id=/g)).toHaveLength(2);
    for (const line of ['Computing minimum C', 'Verifying minimum C', 'Verifying candidate cases', 'Checking four candidate pairs']) {
      expect(html).toContain(`<p><strong>${line}</strong></p>`);
    }
    expect(html).not.toContain('**');
  });

  test('does not combine reasoning across turns or intervening messages', () => {
    const items: TimelineItem[] = [
      { id: 'first', kind: 'reasoning', turnId: 'one', createdAt: 1, text: 'First' },
      { id: 'second', kind: 'reasoning', turnId: 'two', createdAt: 1, text: 'Second' },
      { id: 'answer', kind: 'assistant', turnId: 'two', createdAt: 1, text: 'Answer' },
      { id: 'third', kind: 'reasoning', turnId: 'two', createdAt: 1, text: 'Third' },
    ];
    expect(groupReasoningItems(items).map(group => group.map(item => item.id))).toEqual([
      ['first'], ['second'], ['answer'], ['third'],
    ]);
  });

  test('preserves valid Markdown and code containing literal asterisks', () => {
    for (const text of ['**One**\n\n**Two**', 'An **inline** emphasis', '    **code****example**',
      '```text\n**code****example**\n```', '~~~\n**code****example**\n~~~']) {
      expect(reasoningMarkdown(text)).toBe(text);
    }
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

test('legacy recall records render without dedicated source cards, navigation or Jev totals', () => {
  const legacy = { id: 'legacy-search', kind: 'activity' as const, activity: 'tool' as const,
    label: 'history_search', detail: 'cheshi_history', status: 'completed' as const,
    recall: { operation: 'search', status: 'candidates', sources: [{ threadId: 'past', turnId: 'turn', itemId: 'source',
      title: 'Old source title', text: 'Old source preview' }],
      metrics: { requests: 1, inputTokens: 5, outputTokens: 0, estimatedCostUsd: 0.01, knownEstimatedCostUsd: 0.01,
        unknownRequests: 0, modelMs: 1, totalMs: 2, cacheHits: 0 } } };
  const html = renderHistory([legacy, { id: 'answer', kind: 'assistant', createdAt: 1, text: 'Saved answer' }]);
  expect(html).toContain('history_search');
  expect(html).toContain('Saved answer');
  for (const removed of ['History search', 'Open original message', 'Old source title', 'Old source preview', 'Jev estimated']) {
    expect(html).not.toContain(removed);
  }
});
