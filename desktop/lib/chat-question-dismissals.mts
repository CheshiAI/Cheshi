import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { questionDismissal, questionThreadId } from '../shared/chat-question-dismissals.ts';
import type { ChatQuestionDismissal } from '../shared/chat-question-dismissals.ts';

const identity = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function storedRecord(value: unknown, threadId: string, filename: string): ChatQuestionDismissal {
  const record = questionDismissal(value);
  if ((value as Record<string, unknown>).threadId !== threadId || `${identity(record.questionId)}.json` !== filename) {
    throw new Error('Invalid question dismissal identity. Existing records have been preserved.');
  }
  return record;
}

/** No conversation cache: read only the requested thread; retain only in-flight writes. */
export class ChatQuestionDismissals {
  private readonly directory: string;
  private readonly writes = new Set<Promise<unknown>>();

  constructor(directory: string) { this.directory = directory; }

  async list(value: unknown): Promise<ChatQuestionDismissal[]> {
    const threadId = questionThreadId(value);
    const directory = join(this.directory, identity(threadId));
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if (missing(error)) return []; throw error; }
    const records: ChatQuestionDismissal[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const source = await readFile(join(directory, name), 'utf8');
      records.push(storedRecord(JSON.parse(source), threadId, name));
    }
    return records;
  }

  save(thread: unknown, value: unknown): Promise<ChatQuestionDismissal> {
    const threadId = questionThreadId(thread);
    const record = questionDismissal(value);
    const operation = this.write(threadId, record);
    this.writes.add(operation);
    void operation.then(() => this.writes.delete(operation), () => this.writes.delete(operation));
    return operation;
  }

  async flush(): Promise<void> { await Promise.allSettled([...this.writes]); }

  private async write(threadId: string, record: ChatQuestionDismissal): Promise<ChatQuestionDismissal> {
    const directory = join(this.directory, identity(threadId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, `${identity(record.questionId)}.json`);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(`${JSON.stringify({ threadId, ...record })}\n`, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, filename);
    } finally { await rm(temporary, { force: true }); }
    return record;
  }
}
