import { describe, expect, test } from 'bun:test';
import { activityFromItem, timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { codexThread, createCodexChatService, createFakeCodexClient } from './codex-chat-test-helpers.ts';

export function registerCommandOutputTests() {
  describe('Codex command output', () => {
    const command = {
      type: 'commandExecution', id: 'command-1', command: 'printf "hello\\nworld\\n"',
      status: 'completed', cwd: '/workspace/cheshi', aggregatedOutput: 'hello\nworld\n',
      exitCode: 0, durationMs: 12.5,
    };

    test('restores full command output and execution metadata from thread history', () => {
      expect(timelineFromThread({ thread: codexThread('thread-1', {
        turns: [{ id: 'turn-1', items: [command] }],
      }) })).toEqual([{
        id: 'command-1', kind: 'activity', activity: 'command', label: 'Command',
        detail: command.command, status: 'completed', cwd: command.cwd,
        output: 'hello\nworld\n', exitCode: 0, durationMs: 12.5,
      }]);
    });

    test('distinguishes empty output from unavailable output and preserves whitespace', () => {
      for (const output of ['', '  \n\t']) {
        expect(activityFromItem({ ...command, aggregatedOutput: output }, 'completed', 'fallback'))
          .toMatchObject({ output });
      }
      for (const output of [undefined, null, 0, false, { text: 'not a string' }]) {
        expect(activityFromItem({ ...command, aggregatedOutput: output }, 'completed', 'fallback'))
          .not.toHaveProperty('output');
      }
    });

    test('restores unfinished commands in interrupted or failed turns as stopped without changing completed items', () => {
      for (const status of ['interrupted', 'failed', 'inProgress']) {
        const [unfinished, completed, explicitStop] = timelineFromThread({ thread: codexThread('thread-1', {
          turns: [{ id: 'turn-1', status, items: [
            { ...command, id: 'unfinished', status: 'inProgress', exitCode: null, durationMs: null },
            command,
            { ...command, id: 'explicit-stop', status: 'interrupted' },
          ] }],
        }) });
        expect(unfinished).toMatchObject({ id: 'unfinished', status, output: command.aggregatedOutput, cwd: command.cwd });
        expect(unfinished).not.toHaveProperty('exitCode');
        expect(unfinished).not.toHaveProperty('durationMs');
        expect(completed).toMatchObject({ status: 'completed', exitCode: 0, durationMs: 12.5 });
        expect(explicitStop).toMatchObject({ status: 'interrupted' });
      }
    });

    test('omits invalid or missing metadata without coercing values', () => {
      for (const value of [undefined, null, '0', false, NaN, Infinity, {}]) {
        const activity = activityFromItem({
          ...command, cwd: value, exitCode: value, durationMs: value,
        }, 'completed', 'fallback');
        expect(activity).not.toHaveProperty('exitCode');
        expect(activity).not.toHaveProperty('durationMs');
        if (typeof value !== 'string') expect(activity).not.toHaveProperty('cwd');
      }
      expect(activityFromItem({ ...command, cwd: '', exitCode: 1.5, durationMs: -1 }, 'completed', 'fallback'))
        .toEqual({
          id: 'command-1', kind: 'activity', activity: 'command', label: 'Command',
          detail: command.command, status: 'completed', output: command.aggregatedOutput,
        });
    });

    test('forwards live output only for the viewed active turn and preserves completion snapshots', async () => {
      const client = createFakeCodexClient({
        'thread/start': { thread: codexThread('thread-1') },
        'turn/start': { turn: { id: 'turn-1', items: [], status: 'inProgress' } },
        'turn/interrupt': {},
      });
      const service = createCodexChatService(client);
      const events: Record<string, unknown>[] = [];
      service.onEvent((event) => events.push(event));
      try {
        await service.sendMessage('Run the command', 'client-1');
        const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1' };
        client.emit('item/started', { ...params, item: {
          ...command, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null,
        } });
        client.emit('item/commandExecution/outputDelta', { ...params, delta: 'hello\n' });
        client.emit('item/commandExecution/outputDelta', { ...params, delta: '  \n' });
        client.emit('item/commandExecution/outputDelta', { ...params, delta: 'wrong thread', threadId: 'other' });
        client.emit('item/commandExecution/outputDelta', { ...params, delta: 'wrong turn', turnId: 'other' });
        client.emit('item/commandExecution/outputDelta', { ...params, delta: false });
        client.emit('item/commandExecution/outputDelta', { ...params, delta: 'missing id', itemId: null });
        client.emit('item/completed', { ...params, item: { ...command, status: 'failed', exitCode: 2 } });
        expect(events.filter((event) => event.type === 'command-output-delta')).toEqual([
          { type: 'command-output-delta', ...params, text: 'hello\n' },
          { type: 'command-output-delta', ...params, text: '  \n' },
        ]);
        expect(events.filter((event) => event.type === 'activity')).toMatchObject([
          { item: { status: 'inProgress', cwd: command.cwd } },
          { item: { status: 'failed', output: command.aggregatedOutput, exitCode: 2, durationMs: 12.5 } },
        ]);
        client.emit('turn/completed', { ...params, turn: { id: 'turn-1', status: 'completed' } });
        client.emit('item/commandExecution/outputDelta', { ...params, delta: 'late output' });
        expect(events.filter((event) => event.type === 'command-output-delta')).toHaveLength(2);
      } finally {
        service.stop();
      }
    });
  });
}
