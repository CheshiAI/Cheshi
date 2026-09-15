import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEditorSession, type EditorSession } from '../shared/editor-session.ts';

/** Stores metadata only, in the owning workspace's user-data directory. */
export class EditorSessionStore {
  private readonly directory: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(directory: string) { this.directory = directory; }

  async read(): Promise<EditorSession | null> {
    await this.pending;
    try { return parseEditorSession(JSON.parse(await readFile(join(this.directory, 'editor-session.json'), 'utf8'))); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError
        || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return null;
      throw error;
    }
  }

  save(value: unknown): Promise<void> {
    const session = parseEditorSession(value);
    const operation = this.pending.then(() => this.write(session));
    // A failed write must not block later saves. The caller receives the failure.
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> { await this.pending; }

  private async write(session: EditorSession): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = join(this.directory, 'editor-session.json');
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(`${JSON.stringify(session)}\n`, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, filename);
    } finally { await rm(temporary, { force: true }); }
  }
}
