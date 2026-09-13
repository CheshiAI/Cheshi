import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompiledChatHistoryThread } from './chat-history-compiler.mts';
import { isChatHistoryFileReferences, isChatHistoryItemKind } from '../shared/chat-history-search.ts';
import { recordValue } from './codex-service-utils.mts';

// Bump when the compiler changes derived entries, as well as for cache schema changes.
export const CHAT_HISTORY_INDEX_VERSION = 5;

export interface ChatHistoryIndexRecord {
  version: typeof CHAT_HISTORY_INDEX_VERSION;
  cwd: string;
  sourceKey: string;
  revision: string;
  checkedAt: number;
  title: string;
  updatedAt: number;
  thread: CompiledChatHistoryThread;
}

function validRecord(value: unknown): value is ChatHistoryIndexRecord {
  const record = recordValue(value);
  const thread = recordValue(record?.thread);
  return record?.version === CHAT_HISTORY_INDEX_VERSION && typeof record.cwd === 'string' && typeof record.sourceKey === 'string'
    && typeof record.revision === 'string' && typeof record.title === 'string'
    && typeof record.checkedAt === 'number' && Number.isFinite(record.checkedAt)
    && typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
    && Boolean(thread && typeof thread.threadId === 'string'
      && (thread.parentThreadId === null || typeof thread.parentThreadId === 'string')
      && (thread.forkedFromId === null || typeof thread.forkedFromId === 'string')
      && Array.isArray(thread.entries) && thread.entries.every(value => {
        const entry = recordValue(value);
        return entry && typeof entry.turnId === 'string' && typeof entry.itemId === 'string'
          && typeof entry.text === 'string' && isChatHistoryItemKind(entry.kind)
          && isChatHistoryFileReferences(entry.files);
      }));
}

export function chatHistoryIndexKey(sourceKey: string): string {
  return createHash('sha256').update(sourceKey).digest('hex');
}

/** Disposable derived data. Corrupt/old records are rebuilt from the provider's history. */
export class ChatHistoryIndexStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  async load(sourceKey: string, cwd: string): Promise<ChatHistoryIndexRecord | null> {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(this.directory, `${chatHistoryIndexKey(sourceKey)}.json`), 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError || recordValue(error)?.code === 'ENOENT') return null;
      throw error;
    }
    return validRecord(value) && value.sourceKey === sourceKey && value.cwd === cwd ? value : null;
  }

  async save(record: ChatHistoryIndexRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = chatHistoryIndexKey(record.sourceKey);
    const temporary = join(this.directory, `.${key}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, `${key}.json`));
    } finally { await rm(temporary, { force: true }); }
  }

  async remove(sourceKey: string): Promise<void> {
    await rm(join(this.directory, `${chatHistoryIndexKey(sourceKey)}.json`), { force: true });
  }

  async removeThreads(threadIds: ReadonlySet<string>): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if (recordValue(error)?.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      let value: unknown;
      try { value = JSON.parse(await readFile(join(this.directory, name), 'utf8')); }
      catch (error) {
        if (recordValue(error)?.code === 'ENOENT') continue;
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (!validRecord(value) || threadIds.has(value.thread.threadId)) await rm(join(this.directory, name), { force: true });
    }
  }

  async retain(sourceKeys: readonly string[]): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if (recordValue(error)?.code === 'ENOENT') return; throw error; }
    const retained = new Set(sourceKeys.map(key => `${chatHistoryIndexKey(key)}.json`));
    for (const name of names) {
      if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name)) await rm(join(this.directory, name), { force: true });
    }
  }
}
