import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chatSavedTurn, chatSavedTurnInput } from '../shared/chat-saved-turns.ts';
import type { ChatSavedTurn, ChatSavedTurnInput } from '../shared/chat-saved-turns.ts';

const RECORD_ID = /^[a-f0-9]{64}$/;

function identity(input: ChatSavedTurnInput): string {
  return createHash('sha256').update(JSON.stringify([input.threadId, input.itemId])).digest('hex');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function requireRecord(value: unknown, id: string): ChatSavedTurn {
  const record = chatSavedTurn(value);
  if (record.id !== id || identity(record) !== id) throw new Error('Invalid saved turn identity. Existing saves have been preserved.');
  return record;
}

export class CodexChatSavedTurns {
  private readonly directory: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
  }

  list(): Promise<ChatSavedTurn[]> {
    return this.enqueue(async () => {
      let names: string[];
      try { names = await readdir(this.directory); }
      catch (error) { if (isMissing(error)) return []; throw error; }
      const records: ChatSavedTurn[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!RECORD_ID.test(id)) throw new Error('Invalid saved turn filename. Existing saves have been preserved.');
        const record = await this.read(id);
        if (record) records.push(record);
      }
      return records.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt) || left.id.localeCompare(right.id));
    });
  }

  save(value: unknown): Promise<ChatSavedTurn> {
    const input = chatSavedTurnInput(value);
    const id = identity(input);
    return this.enqueue(async () => {
      const existing = await this.read(id);
      if (existing) return existing;
      const record = { ...input, id, savedAt: new Date().toISOString() };
      await this.write(record);
      return record;
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  delete(id: unknown): Promise<{ id: string }> {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) throw new TypeError('Invalid saved turn id.');
    return this.enqueue(async () => {
      await rm(join(this.directory, `${id}.json`), { force: true });
      return { id };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async read(id: string): Promise<ChatSavedTurn | null> {
    let source: string;
    try { source = await readFile(join(this.directory, `${id}.json`), 'utf8'); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    let value: unknown;
    try { value = JSON.parse(source); }
    catch { throw new Error('Saved turns contain invalid JSON. Existing saves have been preserved.'); }
    return requireRecord(value, id);
  }

  private async write(record: ChatSavedTurn): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.directory, `.${record.id}-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporaryPath, join(this.directory, `${record.id}.json`));
    } finally { await rm(temporaryPath, { force: true }); }
  }
}
