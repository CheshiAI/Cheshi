import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { RpcClient } from './app-server-client.ts';
import type { AgentStore } from './store.ts';
import { record, textValue } from './protocol.ts';

type Input = { threadId: string; turnId: string; text: string | null };
/** Read-only projection of registered native conversations; never accepts paths or RPC methods. */
export class WorkerHistory {
  private readonly store: AgentStore;
  private readonly client: RpcClient;
  private readonly filename: string;
  private readonly workspace: string;
  private inputs: Input[];
  constructor(store: AgentStore, client: RpcClient, directory: string, workspace: string) {
    this.store = store; this.client = client; this.workspace = workspace;
    this.filename = join(directory, 'state', 'history-inputs.json');
    const saved: unknown = existsSync(this.filename) ? JSON.parse(readFileSync(this.filename, 'utf8')) : [];
    if (!Array.isArray(saved) || saved.some(v => !v || typeof v.threadId !== 'string' || typeof v.turnId !== 'string'
      || (v.text !== null && typeof v.text !== 'string'))) throw new Error('Invalid history provenance.');
    this.inputs = saved as Input[];
  }
  remember(threadId: string, turnId: string, text: string | null) {
    const inputs = [...this.inputs.filter(v => v.threadId !== threadId || v.turnId !== turnId), { threadId, turnId, text }];
    writeFileSync(`${this.filename}.tmp`, JSON.stringify(inputs), { mode: 0o600, flush: true });
    renameSync(`${this.filename}.tmp`, this.filename); this.inputs = inputs;
  }
  catalog() {
    const saved = this.store.snapshot();
    const ids = [...new Set([saved.threadId, ...Object.values(saved.threads), ...saved.tasks.map(t => t.threadId)].filter((id): id is string => !!id))];
    return { sessions: ids.map(id => {
      const task = saved.tasks.find(t => t.threadId === id || (t.conversation && saved.threads[t.conversation] === id));
      return { id, title: task?.prompt.slice(0, 200) ?? 'Saved agent conversation',
        updatedAt: Date.parse(task?.finishedAt ?? task?.createdAt ?? '1970-01-01T00:00:00Z') };
    }) };
  }
  async read(value: unknown) {
    const threadId = textValue(record(value).threadId, 'thread id');
    if (!this.catalog().sessions.some(t => t.id === threadId)) throw new Error('Conversation is outside this worker’s history.');
    const raw = record((await this.client.request('thread/read', { threadId, includeTurns: true })).thread);
    if (raw.id !== threadId || raw.cwd !== this.workspace || raw.parentThreadId != null || raw.ephemeral === true || !Array.isArray(raw.turns)) {
      throw new Error('Native conversation scope changed.');
    }
    const turns = raw.turns.map(value => {
      const turn = record(value), provenance = this.inputs.find(v => v.threadId === threadId && v.turnId === turn.id);
      if (!Array.isArray(turn.items)) throw new Error('Invalid native conversation.');
      const saved = this.store.snapshot();
      const authored = saved.tasks.filter(t => t.threadId === threadId || (t.conversation && saved.threads[t.conversation] === threadId)).map(t => t.prompt);
      const items = turn.items.flatMap<Record<string, unknown>>(value => {
        const item = record(value);
        if (item.type === 'agentMessage' && typeof item.text === 'string') return [{ id: item.id, type: item.type, text: item.text }];
        if (item.type !== 'userMessage' || !Array.isArray(item.content)) return [];
        const text = item.content.filter(v => v?.type === 'text').map(v => v.text).join('\n');
        // Older workers lack provenance. Recover only an exact stored task prompt or the known summary wrapper.
        const original = provenance ? provenance.text : authored.find(prompt => text === prompt
          || (text.startsWith('Saved work summary (reference data):\n') && text.endsWith(`\n\nCurrent task:\n${prompt}`)));
        if (!original || !text.endsWith(original)) return [];
        return [{ id: item.id, type: item.type, content: [{ type: 'text', text: original }] }];
      });
      return { id: turn.id, items };
    });
    return { thread: { id: threadId, cwd: this.workspace, turns },
      projection: 'Authored user text and assistant messages only; generated inputs, tools and instructions are omitted.' };
  }
}
