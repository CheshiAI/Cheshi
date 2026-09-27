import { test, expect } from 'bun:test';
import { createChatNotifications } from '../lib/chat-notifications.mts';
import type { ChatNotification } from '../lib/imessage-notifications.mts';
const wait = () => new Promise(resolve => setTimeout(resolve, 12));
function fixture() {
  const events: ChatNotification[] = [];
  const tracker = createChatNotifications({ workspace: 'workspace', notify: event => events.push(event), delayMs: 2 });
  const event = (type: string, extra: Record<string, unknown> = {}, context = 'pane', threadId = 'thread') => tracker.event(context, { type, threadId, ...extra });
  return { tracker, events, event };
}

test('history and duplicate completion events do not notify; live work waits for queue synchronization', async () => {
  const f = fixture();
  try {
    f.event('turn-completed', { status: 'completed' }); await wait(); expect(f.events).toEqual([]);
    f.event('turn-started'); f.event('turn-completed', { status: 'completed' }); await wait(); expect(f.events).toEqual([]);
    f.tracker.queue('pane', []); await wait();
    f.event('turn-completed', { status: 'completed' }); await wait();
    expect(f.events.map(event => event.kind)).toEqual(['completed']);
  } finally { f.tracker.dispose(); }
});

test('completion fires only after the final queue item and the final response, including paused queues', async () => {
  const f = fixture();
  try {
    f.tracker.queue('pane', [{ threadId: 'thread', count: 2 }]);
    f.event('turn-started'); f.event('turn-completed', { status: 'completed' }); await wait();
    expect(f.events).toEqual([]);
    f.event('turn-started'); f.tracker.queue('pane', [{ threadId: 'thread', count: 1 }]);
    f.event('turn-completed', { status: 'completed' }); await wait(); expect(f.events).toEqual([]);
    f.event('turn-started'); f.tracker.queue('pane', []); await wait(); expect(f.events).toEqual([]);
    f.event('turn-completed', { status: 'completed' }); await wait(); expect(f.events).toHaveLength(1);
  } finally { f.tracker.dispose(); }
});

test('approval and user input require attention once, and unresolved requests suppress completion', async () => {
  const f = fixture();
  try {
    f.tracker.queue('pane', []); f.event('turn-started');
    for (let i = 0; i < 2; i++) f.event('approval-requested', { approval: { id: 'a', threadId: 'thread' } });
    f.event('user-input-requested', { request: { id: 'b', threadId: 'thread' } });
    f.event('turn-completed', { status: 'completed' }); await wait();
    expect(f.events.map(event => event.kind)).toEqual(['attention', 'attention']);
    f.event('approval-resolved', { approvalId: 'a' }); f.event('user-input-resolved', { requestId: 'b' }); await wait();
    expect(f.events.at(-1)!.kind).toBe('completed');
  } finally { f.tracker.dispose(); }
});

test('async questions notify without reading their text and failed turns notify only once', async () => {
  const f = fixture();
  try {
    f.tracker.queue('pane', []); f.event('turn-started');
    f.event('assistant-question', { itemId: 'q', questions: [{ title: 'Private text' }] });
    f.event('assistant-question', { itemId: 'q' }); f.event('error'); f.event('turn-completed', { status: 'failed' }); await wait();
    expect(f.events.map(event => event.kind)).toEqual(['attention', 'failed']);
    expect(JSON.stringify(f.events)).not.toContain('Private text');
    f.event('turn-started'); f.event('turn-completed', { status: 'interrupted' }); await wait(); expect(f.events).toHaveLength(2);
  } finally { f.tracker.dispose(); }
});

test('independent panes and closing a pane do not notify from another conversation or stale timers', async () => {
  const f = fixture();
  f.tracker.queue('pane', []); f.tracker.queue('other', []);
  f.event('turn-started'); f.event('turn-started', {}, 'other', 'second');
  f.event('turn-completed', { status: 'completed' }); f.tracker.remove('pane');
  f.event('turn-completed', { status: 'completed' }, 'other', 'second'); await wait();
  expect(f.events.map(event => event.conversation)).toEqual(['Chat second']);
  f.event('turn-started', {}, 'other', 'second'); f.event('turn-completed', { status: 'completed' }, 'other', 'second');
  f.tracker.dispose(); await wait(); expect(f.events).toHaveLength(1);
});

test('replayed turn sequences and stale completions cannot duplicate or finish newer work', async () => {
  const f = fixture();
  try {
    f.tracker.queue('pane', []);
    f.event('turn-started', { turnId: 'first' });
    f.event('turn-completed', { turnId: 'first', status: 'completed' }); await wait();
    f.event('turn-started', { turnId: 'first' });
    f.event('turn-completed', { turnId: 'first', status: 'completed' }); await wait();
    expect(f.events).toHaveLength(1);
    f.event('turn-started', { turnId: 'second' });
    f.event('turn-completed', { turnId: 'first', status: 'completed' }); await wait();
    expect(f.events).toHaveLength(1);
    f.event('turn-completed', { turnId: 'second', status: 'completed' }); await wait();
    expect(f.events).toHaveLength(2);
  } finally { f.tracker.dispose(); }
});
