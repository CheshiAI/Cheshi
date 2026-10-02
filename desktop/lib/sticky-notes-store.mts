import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hasStickyNoteContent, parseStickyNote, stickyNoteBounds, stickyNoteContent, stickyNoteId, stickyNoteIds,
  type StickyNote, type StickyNoteBounds, type StickyNoteSummary, type StickyNoteDeleteResult } from '../shared/sticky-notes.ts';

/** Serialize disk mutations and publish only after the atomic replacement succeeds. */
export class StickyNotesStore {
  private readonly directory: string;
  private readonly notes = new Map<string, StickyNote>();
  private readonly persisted = new Set<string>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string) { this.directory = directory; }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let filenames: string[];
    try { filenames = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      filenames = [];
    }
    const notes = new Map<string, StickyNote>();
    for (const filename of filenames.filter(name => name.endsWith('.json'))) {
      const id = stickyNoteId(filename.slice(0, -5));
      const note = parseStickyNote(JSON.parse(await readFile(path.join(this.directory, filename), 'utf8')));
      if (note.id !== id) throw new Error('Saved note ID does not match its filename.');
      notes.set(id, note);
    }
    for (const [id, note] of notes) { this.notes.set(id, note); this.persisted.add(id); }
    this.loaded = true;
  }

  private run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => { await this.load(); return operation(); });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private current(id: string): StickyNote {
    const note = this.notes.get(stickyNoteId(id));
    if (!note) throw new Error('This note no longer exists.');
    return note;
  }

  private async write(note: StickyNote): Promise<void> {
    const target = path.join(this.directory, `${note.id}.json`);
    if (!hasStickyNoteContent(note)) {
      if (this.persisted.has(note.id)) {
        await unlink(target);
        this.persisted.delete(note.id);
      }
      this.notes.set(note.id, note);
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(note), { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
      this.notes.set(note.id, note);
      this.persisted.add(note.id);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  list(): Promise<StickyNoteSummary[]> {
    return this.run(() => [...this.notes.values()].filter(hasStickyNoteContent).sort((a, b) => b.updatedAt - a.updatedAt).map(note => ({
      id: note.id, title: note.title, preview: note.text.slice(0, 160), updatedAt: note.updatedAt,
    })));
  }

  get(id: string): Promise<StickyNote> { return this.run(() => structuredClone(this.current(id))); }

  create(): Promise<StickyNote> {
    return this.run(async () => {
      const note: StickyNote = { id: randomUUID(), title: '', text: '', pinned: false, bounds: null, updatedAt: Date.now() };
      await this.write(note);
      return structuredClone(note);
    });
  }

  save(id: string, content: unknown): Promise<void> {
    const validated = stickyNoteContent(content);
    return this.run(() => this.write({ ...this.current(id), ...validated, updatedAt: Date.now() }));
  }

  pin(id: string, enabled: unknown): Promise<void> {
    if (enabled !== true && enabled !== false) return Promise.reject(new TypeError('Invalid pin state.'));
    return this.run(() => this.write({ ...this.current(id), pinned: enabled }));
  }

  move(id: string, bounds: StickyNoteBounds): Promise<void> {
    const validated = stickyNoteBounds(bounds);
    return this.run(() => this.write({ ...this.current(id), bounds: validated }));
  }

  delete(id: string): Promise<void> {
    return this.run(async () => {
      this.current(id);
      if (this.persisted.has(id)) await unlink(path.join(this.directory, `${id}.json`));
      this.persisted.delete(id);
      this.notes.delete(id);
    });
  }

  async flush(): Promise<void> { await this.queue; }

  async deleteSelected(value: unknown): Promise<StickyNoteDeleteResult> {
    const ids = stickyNoteIds(value);
    const result: StickyNoteDeleteResult = { deletedIds: [], failedIds: [] };
    for (const id of ids) {
      try { await this.delete(id); result.deletedIds.push(id); }
      catch { result.failedIds.push(id); }
    }
    return result;
  }
}
