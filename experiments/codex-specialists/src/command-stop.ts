import { setTimeout as delay } from 'node:timers/promises';
import type { RpcClient } from './app-server-client.ts';
import { record, textValue, type JsonRecord } from './protocol.ts';

/** TurnObserver supplies only items belonging to the acknowledged thread and turn. */
export class CommandSessions {
  private readonly items = new Map<string, { processId: string | null; completed: boolean }>();

  observe(method: string, item: JsonRecord): void {
    if (item.type !== 'commandExecution') return;
    const id = textValue(item.id, 'command item id'), previous = this.items.get(id);
    this.items.set(id, {
      processId: typeof item.processId === 'string' && item.processId ? item.processId : previous?.processId ?? null,
      completed: method === 'item/completed' || previous?.completed === true,
    });
  }

  private async running(client: RpcClient, threadId: string): Promise<Map<string, string>> {
    const commands = new Map<string, string>(), cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await client.request('thread/backgroundTerminals/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error('Invalid running command list.');
      for (const raw of page.data) {
        const item = record(raw), id = textValue(item.itemId, 'command item id');
        const processId = textValue(item.processId, 'command process id');
        if (this.items.has(id)) commands.set(processId, id);
      }
      if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) throw new Error('Invalid running command cursor.');
      cursor = page.nextCursor as string | null;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated running command cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return commands;
  }

  /** Call after turn completion, before publishing interruption or releasing scratch. */
  async stop(client: RpcClient, threadId: string): Promise<void> {
    if (!this.items.size) return;
    const terminated = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt++) {
      const targets = await this.running(client, threadId);
      for (const [id, item] of this.items) {
        if (!item.completed && item.processId && !terminated.has(id)) targets.set(item.processId, id);
      }
      for (const [processId, id] of targets) {
        const result = await client.request('thread/backgroundTerminals/terminate', { threadId, processId });
        if (result.terminated === true) terminated.add(id);
        else if (result.terminated !== false) throw new Error('Invalid command termination result.');
      }
      // A termination acknowledgement alone does not establish that the session is gone.
      if ((await this.running(client, threadId)).size === 0) return;
      await delay(50);
    }
    throw new Error('Command termination could not be confirmed.');
  }
}
