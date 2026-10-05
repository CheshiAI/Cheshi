import { createHash } from 'node:crypto';
import type { AgentTask } from '../../shared/agent-management.ts';
import type { AgentRoom, RoomMessage } from '../../shared/agent-chats.ts';

export function hasRecordedResponse(task: AgentTask, text: string): boolean {
  const turns = new Map<string, string[]>();
  for (const entry of task.inspection?.activity ?? []) {
    if (entry.kind !== 'message' || !entry.final || entry.truncated) continue;
    turns.set(entry.turnId, [...(turns.get(entry.turnId) ?? []), entry.text]);
  }
  return [...turns.values()].some(messages => messages.join('\n\n') === text);
}

/** Preserve source timestamps and item identity across refresh, sleep and host restart. */
export function recordRoomTasks(messages: RoomMessage[], room: AgentRoom, agentId: string, tasks: AgentTask[]) {
  for (const task of tasks) {
    if (task.roomId !== room.id) continue;
    const anchor = messages.find(m => m.roomId === room.id && m.sender === 'user' && m.recipient === agentId && m.taskId === task.id)
      ?? messages.find(m => m.roomId === room.id && m.relatedTask?.agentId === agentId && m.relatedTask.taskId === task.id);
    if (!anchor) continue;
    for (const question of task.inspection?.dialogue?.questions ?? []) {
      const id = `question_${createHash('sha256').update(`${room.id}/${agentId}/${task.id}/${question.id}`).digest('hex').slice(0, 40)}`;
      const previous = messages.find(m => m.id === id);
      const entry: RoomMessage = { id, roomId: room.id, threadId: anchor.id, sender: agentId, recipient: 'user',
        kind: 'question', text: question.text, taskId: task.id,
        // This is the room's receipt time, retained across refreshes and restarts.
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        userQuestion: { rootId: anchor.id, id: question.id, answered: question.answer !== null } };
      if (previous) Object.assign(previous, entry); else messages.push(entry);
    }
    if (task.inspection) {
      // Activity is persisted below once as timeline entries, not duplicated in the summary.
      anchor.inspection = { ...task.inspection, ...(task.inspection.activity ? { activity: [] } : {}), messages: [] };
      anchor.executionStatus = task.status;
    }
    for (const activity of task.inspection?.activity ?? []) {
      const id = `activity_${createHash('sha256').update(`${room.id}/${agentId}/${task.id}/${activity.id}`).digest('hex').slice(0, 40)}`;
      // An older host may already have saved the final response for this item.
      if (activity.kind === 'message' && messages.some(m => m.roomId === room.id && m.sender === agentId
        && m.taskId === task.id && m.id.startsWith('result_') && m.text === activity.text)) continue;
      const entry: RoomMessage = { id, roomId: room.id, threadId: anchor.kind === 'goal' ? anchor.id : anchor.threadId,
        sender: agentId, recipient: null, kind: 'message', text: activity.kind === 'message' ? activity.text : '',
        taskId: task.id, createdAt: activity.createdAt, activity, status: activity.status };
      const previous = messages.find(m => m.id === id);
      if (previous) Object.assign(previous, entry); else messages.push(entry);
    }
  }
}
