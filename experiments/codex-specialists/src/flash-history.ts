import { createHash } from 'node:crypto';
import { record } from './protocol.ts';
import type { AgentStore } from './store.ts';

export class FlashHistoryChanged extends Error {}

export interface FlashEntry { turnId: string; itemId: string; kind: 'user' | 'assistant'; text: string }
export interface FlashSession { threadId: string; title: string; entries: FlashEntry[] }
export const flashId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,1024}$/.test(value)) throw new Error('Invalid Flash source identity.');
  return value;
};
export function parseFlashSession(value: unknown): FlashSession {
  const session = record(value);
  if (typeof session.title !== 'string' || [...session.title].length > 2000 || !Array.isArray(session.entries)) throw new Error('Invalid Flash session.');
  const seen = new Set<string>();
  const entries = session.entries.map(raw => {
    const e = record(raw), turnId = flashId(e.turnId), itemId = flashId(e.itemId), key = `${turnId}/${itemId}`;
    if (seen.has(key) || !['user', 'assistant'].includes(String(e.kind)) || typeof e.text !== 'string' || !e.text.trim()) throw new Error('Invalid Flash entry.');
    seen.add(key);
    return { turnId, itemId, kind: e.kind as FlashEntry['kind'], text: e.text };
  });
  return { threadId: flashId(session.threadId), title: session.title, entries };
}

/** Export only completed visible messages from threads owned by this worker's task journal. */
export class WorkerFlashHistory {
  private readonly store: AgentStore;
  private readonly read: (id: string) => Promise<unknown>;
  constructor(store: AgentStore, read: (id: string) => Promise<unknown>) { this.store = store; this.read = read; }
  private state() {
    const tasks = this.store.snapshot().tasks;
    const revision = createHash('sha256').update(JSON.stringify(tasks.map(t => [t.id, t.threadId, t.turnId, t.status, t.output, t.inputs, t.responses]))).digest('hex');
    return { tasks, revision };
  }
  async page(value: unknown) {
    const input = record(value), { tasks, revision } = this.state();
    if (input.revision === revision && input.after === undefined) return { revision, unchanged: true };
    if (input.after !== undefined && input.revision !== revision) throw new FlashHistoryChanged('Flash history changed during pagination. Retry.');
    const ids = [...new Set(tasks.flatMap(t => t.threadId ? [t.threadId] : []))].sort();
    const after = input.after === undefined ? '' : flashId(input.after);
    const id = ids.find(id => id > after);
    if (!id) return { revision, session: null, next: null };
    const response = record(await this.read(id)), thread = record(response.thread);
    if (thread.id !== id || thread.ephemeral === true || thread.parentThreadId != null || !Array.isArray(thread.turns)) throw new Error('Flash history does not belong to a saved worker session.');
    const entries: FlashEntry[] = [];
    for (const raw of thread.turns) {
      const turn = record(raw);
      if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) continue;
      if (!Array.isArray(turn.items)) throw new Error('Invalid Flash turn.');
      for (const value of turn.items) {
        const item = record(value);
        let text = '';
        if (item.type === 'agentMessage' && typeof item.text === 'string') text = item.text;
        if (item.type === 'userMessage' && Array.isArray(item.content)) text = item.content.map(raw => {
          const part = record(raw);
          return part.type === 'text' && typeof part.text === 'string' ? part.text : part.type === 'mention' && typeof part.name === 'string' ? `@${part.name}` : part.type === 'skill' && typeof part.name === 'string' ? `$${part.name}` : '';
        }).filter(Boolean).join('\n');
        if (text.trim()) entries.push({ turnId: flashId(turn.id), itemId: flashId(item.id), kind: item.type === 'userMessage' ? 'user' : 'assistant', text });
      }
    }
    if (this.state().revision !== revision) throw new FlashHistoryChanged('Flash history changed during export. Retry.');
    const session = parseFlashSession({ threadId: id, title: [...String(thread.name ?? tasks.find(t => t.threadId === id)?.prompt ?? 'Docker session')].slice(0, 2000).join(''), entries });
    if (JSON.stringify(session).length > 8 * 1024 * 1024) throw new Error('Flash session exceeds export limit; no text was truncated.');
    return { revision, session, next: ids.some(other => other > id) ? id : null };
  }
}
