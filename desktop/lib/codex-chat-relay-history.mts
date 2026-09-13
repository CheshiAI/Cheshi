import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chatRelayHistoryRecord } from '../shared/chat-relay.ts';
import type { ChatRelayHistoryRecord } from '../shared/chat-relay.ts';

const RECORD_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function requireChatRelayHistoryId(id: unknown): string {
  if (typeof id !== 'string' || !RECORD_ID.test(id)) throw new TypeError('Invalid conversation history id.');
  return id;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function requireRecord(value: unknown, expectedId?: string): ChatRelayHistoryRecord {
  const record = chatRelayHistoryRecord(value);
  if (!record || !RECORD_ID.test(record.id) || (expectedId !== undefined && record.id !== expectedId)) {
    throw new Error('Invalid conversation history record. Existing history has been preserved.');
  }
  return record;
}

export class CodexChatRelayHistory {
  private readonly directory: string;
  private queue: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | null = null;
  private readonly deletedIds = new Set<string>();

  constructor(directory: string) {
    this.directory = directory;
  }

  list(): Promise<ChatRelayHistoryRecord[]> {
    return this.enqueue(async () => {
      await this.initialize();
      const records = await this.readRecords();
      return records.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id));
    });
  }

  save(value: ChatRelayHistoryRecord): Promise<void> {
    // Snapshot before entering the queue; callers may advance their live state.
    const record = requireRecord(structuredClone(value));
    return this.enqueue(async () => {
      if (this.deletedIds.has(record.id)) return;
      await this.initialize();
      await this.readRecord(record.id);
      await this.writeRecord(record);
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  delete(value: unknown): Promise<{ id: string }> {
    const id = requireChatRelayHistoryId(value);
    return this.enqueue(async () => {
      await rm(join(this.directory, `${id}.json`), { force: true });
      this.deletedIds.add(id);
      return { id };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private initialize(): Promise<void> {
    this.initialization ??= this.recoverInterruptedRecords().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  private async recoverInterruptedRecords(): Promise<void> {
    // Validate the whole archive before modifying anything, including recovery.
    const records = await this.readRecords();
    for (const record of records) {
      if (record.state.status !== 'running' && record.state.status !== 'stopping') continue;
      const recoveredAt = new Date(Math.max(Date.now(), Date.parse(record.updatedAt))).toISOString();
      await this.writeRecord({ ...record, updatedAt: recoveredAt, finishedAt: recoveredAt,
        state: { ...record.state, status: 'stopped', outcome: null,
          message: 'Conversation interrupted by an app restart. It was not resumed.' } });
    }
  }

  private async readRecords(): Promise<ChatRelayHistoryRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const records: ChatRelayHistoryRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!RECORD_ID.test(id)) throw new Error('Invalid conversation history filename. Existing history has been preserved.');
      const record = await this.readRecord(id);
      if (record) records.push(record);
    }
    return records;
  }

  private async readRecord(id: string): Promise<ChatRelayHistoryRecord | null> {
    let source: string;
    try { source = await readFile(join(this.directory, `${id}.json`), 'utf8'); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    let value: unknown;
    try { value = JSON.parse(source); }
    catch { throw new Error('Conversation history contains invalid JSON. Existing history has been preserved.'); }
    return requireRecord(value, id);
  }

  private async writeRecord(record: ChatRelayHistoryRecord): Promise<void> {
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
