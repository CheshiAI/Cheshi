import { expect, test } from 'bun:test';
import { agentFromThread } from '../lib/codex-chat-thread-data.mts';

test('agent loading status is preserved independently of completed work in its history', () => {
  const agent = agentFromThread({
    id: 'child', parentThreadId: 'root', status: { type: 'notLoaded' },
    turns: [{ id: 'turn', status: 'completed', items: [] }],
  }, 'root', 'child', 1);
  expect(agent).toMatchObject({ status: 'notLoaded', current: true });
});

test('missing or malformed agent status is unknown rather than assumed unloaded', () => {
  for (const status of [undefined, null, {}, { type: '' }, { type: false }, 'notLoaded']) {
    expect(agentFromThread({ id: 'child', parentThreadId: 'root', status }, 'root', 'root', 1)?.status)
      .toBe('unknown');
  }
});

test('runtime statuses remain available for explicit presentation without changing agent selection', () => {
  for (const status of ['idle', 'active', 'systemError', 'futureStatus']) {
    expect(agentFromThread({ id: 'child', parentThreadId: 'root', status: { type: status } }, 'root', 'root', 1))
      .toMatchObject({ id: 'child', status, current: false, kind: 'subagent' });
  }
});
