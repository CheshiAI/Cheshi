import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandActivity } from '../frontend/src/features/chat/CommandActivity';
import { chatReducer, INITIAL_CHAT_STATE, normalizeChatEvent, normalizeOpenSessionResponse } from '../frontend/src/features/chat/model';
import type { ChatActivityItem, ChatState } from '../frontend/src/features/chat/model';

const command: ChatActivityItem = { id: 'command', kind: 'activity', activity: 'command', label: 'Command',
  detail: 'git status\ngit diff', status: 'completed' };

function apply(state: ChatState, value: unknown): ChatState {
  const event = normalizeChatEvent(value);
  if (!event) throw new Error('Expected a valid event');
  return chatReducer(state, { type: 'event', event });
}

describe('command activity', () => {
  test('exposes full command and literal multiline output in a native disclosure', () => {
    const html = renderToStaticMarkup(<CommandActivity item={{ ...command, output: '<script>no()</script>\n**literal**\nlast line',
      cwd: '/workspace', exitCode: 0, durationMs: 1250 }} />);
    expect(html).toContain('<details>');
    expect(html).toContain('<summary');
    expect(html).toContain('aria-label="Full command"');
    expect(html).toContain('git status\ngit diff');
    expect(html).toContain('&lt;script&gt;no()&lt;/script&gt;\n**literal**\nlast line');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Exit code: 0');
    expect(html).toContain('Duration: 1.25s');
    expect(html).toContain('Directory: /workspace');
  });

  test('distinguishes missing historical output from empty output and an active command', () => {
    const render = (item: ChatActivityItem) => renderToStaticMarkup(<CommandActivity item={item} />);
    expect(render(command)).toContain('Output is not available in this record.');
    expect(render({ ...command, output: '' })).toContain('No output.');
    expect(render({ ...command, status: 'inProgress' })).toContain('Waiting for output…');
    expect(render({ ...command, status: 'failed', exitCode: 1 })).toContain('Failed');
  });

  test('preserves command fields when reopening a session and validates external metadata', () => {
    const session = { id: 'thread', title: 'Thread', preview: '', createdAt: 1, updatedAt: 2, status: 'idle' };
    const item = { ...command, output: '', cwd: '/workspace', exitCode: 0, durationMs: 0 };
    const response = normalizeOpenSessionResponse({ session, items: [item], responseInProgress: false });
    expect(response.items).toEqual([item]);
    const event = normalizeChatEvent({ type: 'activity', threadId: 'thread', item: {
      ...command, output: {}, cwd: true, exitCode: '0', durationMs: -1,
    } });
    expect(event?.type === 'activity' && event.item).toEqual(command);
  });

  test('shows interrupted responses without implying command termination or success', () => {
    const html = renderToStaticMarkup(<CommandActivity item={{ ...command, status: 'interrupted', output: 'partial output' }} />);
    expect(html).toContain('Response stopped');
    expect(html).toContain('partial output');
    expect(html).not.toContain('Completed');
    expect(html).not.toContain('Running');
    expect(html).not.toContain('Waiting for output');
  });

  test('streams output only to its thread and replaces it with the completed snapshot without duplicating', () => {
    let state: ChatState = { ...INITIAL_CHAT_STATE, activeSessionId: 'thread' };
    const delta = (text: string, threadId = 'thread') => ({ type: 'command-output-delta', threadId, itemId: 'command', text });
    state = apply(state, { type: 'activity', threadId: 'thread', item: { ...command, status: 'inProgress' } });
    state = apply(state, delta('first\n'));
    expect(apply(state, delta('other', 'other-thread'))).toBe(state);
    state = apply(state, delta('second\n'));
    expect(state.items[0]).toMatchObject({ output: 'first\nsecond\n' });
    state = apply(state, { type: 'activity', threadId: 'thread', item: { ...command, output: 'first\nsecond\n', exitCode: 0 } });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ output: 'first\nsecond\n', status: 'completed', exitCode: 0 });
    expect(apply(state, delta('late'))).toBe(state);
  });

  test('retains streamed output when the final event omits output', () => {
    let state: ChatState = { ...INITIAL_CHAT_STATE, activeSessionId: 'thread' };
    state = apply(state, { type: 'command-output-delta', threadId: 'thread', itemId: 'command', text: 'result' });
    state = apply(state, { type: 'activity', threadId: 'thread', item: command });
    expect(state.items[0]).toMatchObject({ detail: command.detail, output: 'result', status: 'completed' });
  });
});
