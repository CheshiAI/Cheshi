import { expect, test } from 'bun:test';
import { createWorkspaceDiscord } from '../lib/workspace-discord.mts';
import type { DiscordTarget, DiscordBridge } from '../lib/discord-service.mts';
import type { CodexChatService } from '../lib/codex-chat-service.mts';

test('a channel retains its session after UI navigation; busy instructions steer and approvals block execution', async () => {
  const targets = new Map<string, DiscordTarget>(), calls: Array<{ type: string; thread: unknown }> = [];
  let access = 'read-only';
  const service = { viewedThreadId: 'one', threadIsSubagent: new Map(), activeTurns: new Map(), pendingTurnStarts: new Set(),
    pendingApprovals: new Map(), userInputs: { list: () => [] },
    emit: () => {}, permissionOverrides: () => ({ access }), sendMessage: async (_text: unknown, _id: unknown, _skill: unknown, _attachments: unknown, thread: unknown) => {
      calls.push({ type: 'send', thread }); return { threadId: String(thread), turnId: 'turn' };
    },
    steerMessage: async (_text: unknown, _id: unknown, _skill: unknown, _attachments: unknown, thread: unknown) => { calls.push({ type: 'steer', thread }); },
    cancelResponse: async () => ({ requested: true }),
  };
  const bridge: DiscordBridge = { observe: target => { targets.set(target.thread, target); return target.thread; },
    sessions: () => [], continue() {}, event() {}, unavailable() {} };
  let queue = 0;
  const adapter = createWorkspaceDiscord({ workspace: '/project', bridge,
    services: () => [{ contextId: 'pane', service: service as unknown as CodexChatService }], queueSize: () => queue });
  adapter.event('pane', { type: 'session-created', session: { id: 'one', title: 'New chat' } });
  service.viewedThreadId = 'two';
  adapter.event('pane', { type: 'session-created', session: { id: 'two', title: 'Second' } });
  const run = (text: string) => targets.get('one')!.execute(text, 'id', new AbortController().signal);
  await run('hello'); expect(calls).toEqual([{ type: 'send', thread: 'one' }]);
  service.activeTurns.set('one', {}); await run('more'); expect(calls.at(-1)).toEqual({ type: 'steer', thread: 'one' });
  service.pendingApprovals.set('approval', { threadId: 'one' });
  expect((await run('approve')).text).toContain('승인'); expect(calls).toHaveLength(2);
  service.pendingApprovals.clear(); queue = 1;
  expect((await run('중지')).text).toContain('대기열'); expect(calls).toHaveLength(2);
  service.activeTurns.clear(); queue = 0; access = 'full-access';
  expect((await run('실행')).text).toContain('권한'); expect(calls).toHaveLength(2);
  adapter.dispose();
});

test('an account handoff keeps one channel when selection changes before turn-start acknowledgement', async () => {
  const channels = new Map<string, { key: string; target: DiscordTarget }>();
  const sent: unknown[] = [];
  let count = 0;
  let emit: (value: Record<string, unknown>) => void = () => {};
  const service = { viewedThreadId: 'old', threadIsSubagent: new Map(), activeTurns: new Map(), pendingTurnStarts: new Set(),
    pendingApprovals: new Map(), userInputs: { list: () => [] }, permissionOverrides: () => ({ access: 'read-only' }), emit() {},
    async sendMessage(_text: unknown, id: unknown, _skill: unknown, _attachments: unknown, thread: unknown) {
      sent.push(thread); service.viewedThreadId = 'new';
      emit({ type: 'session-selected', threadId: 'new', previousThreadId: thread });
      emit({ type: 'turn-started', threadId: 'new', clientMessageId: id, turnId: 'turn' });
      return { threadId: 'new', turnId: 'turn' };
    } };
  const bridge: DiscordBridge = {
    sessions: () => [], event() {}, unavailable() {},
    observe(target) {
      const key = channels.get(target.thread)?.key ?? `channel-${++count}`;
      channels.set(target.thread, { key, target }); return key;
    },
    continue(key, thread) {
      const entry = [...channels.entries()].find(([, value]) => value.key === key)!;
      channels.delete(entry[0]); channels.set(thread, entry[1]);
    },
  };
  const adapter = createWorkspaceDiscord({ workspace: '/project', bridge, queueSize: () => 0,
    services: () => [{ contextId: 'pane', service: service as unknown as CodexChatService }] });
  emit = value => adapter.event('pane', value);
  emit({ type: 'session-created', session: { id: 'old', title: 'Old' } });
  await channels.get('old')!.target.execute('start', 'request', new AbortController().signal);
  expect(count).toBe(1); expect(channels.get('new')?.key).toBe('channel-1');
  await channels.get('new')!.target.execute('again', 'request-2', new AbortController().signal);
  expect(sent).toEqual(['old', 'new']); expect(count).toBe(1); adapter.dispose();
});
