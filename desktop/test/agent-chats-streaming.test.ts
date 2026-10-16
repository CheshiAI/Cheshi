import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatsStore } from '../lib/agent-chats/store.mts';
import { ChatsChanges } from '../lib/agent-chats/changes.mts';
import { hasRecordedResponse, recordRoomTasks } from '../lib/agent-chats/records.mts';
import { createChatsSnapshotStore } from '../frontend/src/features/agent-chats/useChatsSnapshot';
import type { AgentTask } from '../shared/agent-management';
import { parseChatsUpdate, type AgentRoom, type ChatsUpdate } from '../shared/agent-chats';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('worker text updates one renderer record without journal writes; completion survives reconnect and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheshi-chat-stream-')); directories.push(directory);
  const filename = join(directory, 'chats.json'), store = new ChatsStore(filename);
  const room: AgentRoom = { id: 'room', workspace: '/project', name: 'Work', engineId: 'docker:test',
    defaultAgentId: 'atlas', members: [{ id: 'atlas', accountId: 'account', name: 'Atlas' }], createdAt: '2026-10-16' };
  store.update(s => {
    s.rooms.push(room);
    s.messages.push({ id: 'prompt', roomId: room.id, threadId: null, sender: 'user', recipient: 'atlas', kind: 'message',
      taskId: 'task', text: 'Explain', createdAt: '2026-10-16' });
  });
  const task: AgentTask = { id: 'task', roomId: 'room', prompt: 'Explain', status: 'running', createdAt: '2026-10-16', output: '', error: null,
    inspection: { finishedAt: null, threadId: 'thread', conversation: null, goal: null, messages: [], evidence: [], error: null, activity: [] } };
  const record = () => store.update(s => recordRoomTasks(s.messages, room, 'atlas', [task]));
  record();
  const saved = readFileSync(filename, 'utf8'), inode = statSync(filename).ino;
  const changes = new ChatsChanges(workspace => store.snapshot(workspace)), updates: ChatsUpdate[] = [];
  const renderer = createChatsSnapshotStore({ request: async () => changes.snapshot('/project') });
  await renderer.refresh(); const original = renderer.getSnapshot().snapshot.messages[0];
  const unsubscribe = changes.subscribe('/project', event => { updates.push(event); renderer.receive(parseChatsUpdate(event)); });
  const stop = store.subscribe(() => changes.publish());
  try {
    const activity = { id: 'native', turnId: 'turn', kind: 'message' as const, title: '', text: '안녕', status: 'running' as const,
      createdAt: '2026-10-16', final: true, truncated: false };
    task.inspection!.activity = [activity]; record();
    const first = renderer.getSnapshot().snapshot.messages[1]!;
    expect(first.text).toBe('안녕'); expect(hasRecordedResponse(task, '안녕')).toBe(false);
    task.inspection!.activity = [{ ...activity, text: '안녕하세요' }]; record();
    expect(renderer.getSnapshot().snapshot.messages).toHaveLength(2);
    expect(renderer.getSnapshot().snapshot.messages[1]).toMatchObject({ id: first.id, text: '안녕하세요', status: 'running' });
    expect(renderer.getSnapshot().snapshot.messages[0]).toBe(original);
    expect(updates.every(update => update.messages.length === 1)).toBe(true);
    expect(readFileSync(filename, 'utf8')).toBe(saved); expect(statSync(filename).ino).toBe(inode);
    expect(new ChatsStore(filename).snapshot('/project').messages).toHaveLength(1);
    // Reconnect restores the current preview from memory without invoking the model.
    await renderer.refresh(); expect(renderer.getSnapshot().snapshot.messages[1]!.text).toBe('안녕하세요');
    task.inspection!.activity = [{ ...activity, text: '최종 답변', status: 'completed' }]; record();
    expect(hasRecordedResponse(task, '최종 답변')).toBe(true);
    expect(renderer.getSnapshot().snapshot.messages[1]).toMatchObject({ id: first.id, text: '최종 답변', status: 'completed' });
    expect(new ChatsStore(filename).snapshot('/project').messages[1]).toMatchObject({ id: first.id, text: '최종 답변', status: 'completed' });
    task.inspection!.activity = [{ ...activity, id: 'partial', status: 'unknown', text: '중단된 답변' }]; record();
    expect(hasRecordedResponse(task, '중단된 답변')).toBe(false);
    expect(new ChatsStore(filename).snapshot('/project').messages.at(-1)).toMatchObject({ text: '중단된 답변', status: 'unknown' });
  } finally { stop(); unsubscribe(); changes.dispose(); }
});
