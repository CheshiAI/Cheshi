import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentChats } from '../lib/agent-chats/service.mts';
import { hasRecordedResponse } from '../lib/agent-chats/records.mts';
import { specialistAgent } from './agent-registry-fixtures';
import type { AgentDetails, AgentTask } from '../shared/agent-management';
import type { RoomMessage } from '../shared/agent-chats';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function finalActivity(id = 'final', text = 'Capture complete'): NonNullable<RoomMessage['activity']> {
  return { id, turnId: 'turn', kind: 'message', title: '', text, status: 'completed',
    createdAt: '2026-10-16T10:01:00Z', final: true, truncated: false };
}
function savedMessage(activity = finalActivity(), patch: Partial<RoomMessage> = {}): RoomMessage {
  return { id: `activity_${activity.id}`, roomId: 'room', taskId: 'task', threadId: 'goal', sender: 'atlas', recipient: null,
    kind: 'message', text: activity.text, createdAt: activity.createdAt, activity, ...patch };
}
function taskFixture(): AgentTask {
  return { id: 'task', roomId: 'room', prompt: 'Capture', status: 'interrupted', createdAt: '2026-10-16T10:00:00Z', output: '', error: null,
    inspection: { finishedAt: null, threadId: 'native', conversation: 'task', goal: null, messages: [], evidence: [], error: null, activity: [] } };
}
async function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-response-replay-'))); directories.push(workspace);
  const agent = { ...specialistAgent(), id: 'atlas', name: 'Atlas', accountId: 'account', assignments: [{ workspaceRoot: workspace, instructions: '' }] };
  const details: AgentDetails = { agent: { id: 'container', name: 'Atlas', state: 'running', image: 'worker' }, ready: true,
    authenticated: true, busy: false, threadId: null, error: null, logs: '', tasks: [] };
  let dispatches = 0;
  const options: Parameters<typeof createAgentChats>[0] = { filename: join(workspace, 'chats.json'),
    registry: () => ({ workspaceRoot: workspace, agents: [agent] }), status: async () => ({ details }),
    dispatch: async (_workspace, input, context) => {
      dispatches++;
      details.tasks.push({ ...taskFixture(), id: input.taskId!, prompt: input.prompt!, roomId: context.roomId });
      return { details };
    } };
  const service = createAgentChats(options);
  service.request(workspace, { action: 'create', id: 'room', name: 'Capture', engineId: 'docker:test', members: ['atlas'], defaultAgentId: 'atlas' });
  service.request(workspace, { action: 'send', id: 'goal', roomId: 'room', threadId: null, recipient: 'atlas', text: 'Capture', goal: true });
  await service.tick();
  return { workspace, options, service, task: details.tasks[0]!, dispatches: () => dispatches };
}

test.each(['empty', 'missing'] as const)('saved finals keep their identity and time when worker activity is %s, including restart', async mode => {
  const f = await fixture(), text = 'Capture complete';
  let restarted: ReturnType<typeof createAgentChats> | undefined;
  const messages = (service = f.service) => service.request(f.workspace, { action: 'list' }).messages.filter(m => m.text === text);
  try {
    f.task.inspection!.activity = [finalActivity()];
    f.task.responses = [{ id: 'response_1', text, status: 'interrupted' }];
    await f.service.tick();
    const before = messages();
    expect(before).toHaveLength(1);
    expect(before[0]!.createdAt).toBe('2026-10-16T10:01:00Z');
    if (mode === 'empty') { f.task.inspection!.activity = []; f.task.inspection!.activityTruncated = true; }
    else delete f.task.inspection;
    await f.service.tick(); await f.service.tick();
    expect(messages()).toEqual(before);
    await f.service.dispose();
    restarted = createAgentChats(f.options);
    await restarted.tick(); await restarted.tick();
    expect(messages(restarted)).toEqual(before);
    expect(f.dispatches()).toBe(1);
  } finally { await f.service.dispose(); await restarted?.dispose(); }
});

test('a partially retained multi-message final uses saved pieces once in their original order', async () => {
  const f = await fixture(), first = finalActivity('first', 'Capture complete'), last = finalActivity('last', 'Cleanup complete');
  last.createdAt = '2026-10-16T10:01:01Z';
  try {
    f.task.inspection!.activity = [first, last];
    f.task.responses = [{ id: 'response_1', text: `${first.text}\n\n${last.text}`, status: 'interrupted' }];
    await f.service.tick();
    const before = f.service.request(f.workspace, { action: 'list' }).messages;
    expect(before.filter(m => m.activity)).toHaveLength(2);
    f.task.inspection!.activity = [last]; f.task.inspection!.activityTruncated = true;
    await f.service.tick();
    const after = f.service.request(f.workspace, { action: 'list' }).messages;
    expect(after.filter(m => m.activity)).toEqual(before.filter(m => m.activity));
    expect(after.some(m => m.id.startsWith('result_'))).toBe(false);
  } finally { await f.service.dispose(); }
});

test.each(['roomId', 'taskId', 'sender'] as const)('identical words from another %s do not hide this response', field => {
  const task = taskFixture(), activity = finalActivity();
  const messages = [savedMessage(activity, { [field]: 'other' })];
  expect(hasRecordedResponse(task, activity.text, { messages, agentId: 'atlas' })).toBe(false);
});

test('only complete final messages from one turn suppress a response', () => {
  const task = taskFixture(), activity = finalActivity();
  for (const patch of [{ status: 'running' as const }, { status: 'unknown' as const }, { final: false }, { truncated: true }, { kind: 'command' as const }]) {
    expect(hasRecordedResponse(task, activity.text, { messages: [savedMessage({ ...activity, ...patch })], agentId: 'atlas' })).toBe(false);
  }
  const messages = [savedMessage(finalActivity('first', 'First')), savedMessage({ ...finalActivity('last', 'Last'), turnId: 'another-turn' })];
  expect(hasRecordedResponse(task, 'First\n\nLast', { messages, agentId: 'atlas' })).toBe(false);
  expect(hasRecordedResponse(task, activity.text, { messages: [savedMessage(activity)], agentId: 'atlas' })).toBe(true);
});
