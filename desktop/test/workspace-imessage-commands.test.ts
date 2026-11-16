import { expect, test } from 'bun:test';
import type { CodexChatService } from '../lib/codex-chat-service.mts';
import { chatCommandEndpoint } from '../lib/workspace-imessage-commands.mts';

function fixture() {
  const calls: { type: string; args: unknown[] }[] = [];
  const service = {
    viewedThreadId: 'thread', viewedThreadIsSubagent: false,
    activeTurns: new Map<string, { turnId: string }>(), pendingTurnStarts: new Set<string>(),
    pendingApprovals: new Map<string, { threadId: string }>(), userInputs: { list: () => [] },
    emit: (...args: unknown[]) => { calls.push({ type: 'emit', args }); },
    sendMessage: async (...args: unknown[]) => { calls.push({ type: 'send', args }); return { threadId: 'thread', turnId: 'turn' }; },
    steerMessage: async (...args: unknown[]) => { calls.push({ type: 'steer', args }); },
    cancelResponse: async (...args: unknown[]) => { calls.push({ type: 'cancel', args }); return { requested: true }; },
  };
  let count = 0;
  const target = chatCommandEndpoint({ id: 'target', label: 'Test', threadId: 'thread',
    service: service as unknown as CodexChatService, queueSize: () => count,
    targetForThread: id => ({ id, label: `Test ${id}` }) });
  return { service, calls, target, queue: (next: number) => { count = next; },
    run: (text: string) => target.execute(text, 'message', new AbortController().signal) };
}
test('idle instructions start once and active instructions steer the selected thread with existing settings', async () => {
  const f = fixture();
  expect(await f.run('계속해줘')).toContain('Work has started');
  expect(f.calls.map(call => call.type)).toEqual(['emit', 'send']);
  expect(f.calls[1]!.args.slice(0,5)).toEqual(['계속해줘', 'message', null, [], 'thread']);
  f.calls.length = 0; f.service.activeTurns.set('thread', { turnId: 'turn' });
  expect(await f.run('테스트도 해줘')).toContain('additional instruction');
  expect(f.calls.map(call => call.type)).toEqual(['emit', 'steer']);
  expect(f.calls[1]!.args).toEqual(['테스트도 해줘', 'message', null, [], 'thread']);
});

test('account continuation follows only the returned thread that remains selected', async () => {
  const f = fixture();
  f.service.sendMessage = async () => {
    f.service.viewedThreadId = 'continued';
    return { threadId: 'continued', turnId: 'turn' };
  };
  expect(await f.run('계속해줘')).toEqual({ reply: 'Instruction received. Work has started.',
    continuedTarget: { id: 'continued', label: 'Test continued' } });
  f.service.viewedThreadId = 'thread';
  f.service.sendMessage = async () => {
    f.service.viewedThreadId = 'unrelated';
    return { threadId: 'continued', turnId: 'turn' };
  };
  expect(typeof await f.run('계속해줘')).toBe('string');
});
test.each([{ status: 'status', stop: 'stop' }, { status: 'STATUS', stop: 'STOP' }, { status: '상태', stop: '중지' }])('status and stop only target the selected conversation: %j', async ({ status, stop }) => {
  const f = fixture();
  expect(await f.run(status)).toContain('Idle'); expect(f.calls).toEqual([]);
  f.service.activeTurns.set('thread', { turnId: 'turn' });
  expect(await f.run(status)).toContain('Working');
  await f.run(stop); expect(f.calls).toEqual([{ type: 'cancel', args: ['thread'] }]);
});
test('queued work and pending human decisions are not bypassed by remote instructions', async () => {
  const f = fixture();
  f.queue(2);
  expect(await f.run('중지')).toContain('queue'); expect(await f.run('시작해줘')).toContain('queue');
  expect(await f.run('상태')).toContain('Queued messages: 2'); expect(f.calls).toEqual([]);
  f.queue(0); f.service.pendingApprovals.set('approval', { threadId: 'thread' });
  expect(await f.run('허용')).toContain('Respond in Cheshi'); expect(f.calls).toEqual([]);
});
test('changed conversations and revoked command lifetimes cannot send', async () => {
  const f = fixture(); f.service.viewedThreadId = 'different';
  let failure: unknown;
  try { await f.run('실행'); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(f.calls).toEqual([]);
  f.service.viewedThreadId = 'thread'; const lifetime = new AbortController(); lifetime.abort();
  failure = undefined;
  try { await f.target.execute('실행', 'message', lifetime.signal); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(f.calls).toEqual([]);
});
