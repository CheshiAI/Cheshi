import type { AppleNote, AppleNoteSummary, AppleNotesFolder, AppleNotesPage } from '../shared/apple-notes.ts';
import { notesSearchRequest, type NotesSearchResponse, type NotesSearchStatus } from '../shared/apple-notes-search.ts';
import { NotesSearchWorker } from './apple-notes-search-worker-client.mts';
import type { IndexedNote } from './apple-notes-search-store.mts';

export interface NotesSearchSource {
  folders(): Promise<AppleNotesFolder[]>;
  list(folderId: string, offset: number): Promise<AppleNotesPage>;
  read(id: string): Promise<AppleNote>;
}
/** Queries read the committed index while source reads proceed independently. */
export class AppleNotesSearch {
  private readonly worker: NotesSearchWorker;
  private readonly source: NotesSearchSource;
  private readonly initialized: Promise<void>;
  private syncing: Promise<void> | null = null;
  private stopped = false;
  private epoch = 0;
  private ready = false;
  private completed = 0;
  private pending = 0;
  private error: string | null = null;
  private started = false;
  private dirty = true;
  private readonly blocked = new Set<string>();
  constructor(filename: string, source: NotesSearchSource) {
    this.worker = new NotesSearchWorker(filename);
    this.source = source;
    this.initialized = this.worker.request<{ ready: boolean }>({ type: 'catalog' }).then(state => { this.ready = state.ready; });
  }
  status(): NotesSearchStatus {
    return { state: this.error ? 'error' : !this.started ? 'idle' : this.syncing || this.dirty ? this.ready ? 'updating' : 'building' : 'ready',
      completed: this.completed, pending: this.pending, error: this.error };
  }
  async start() {
    if (this.stopped || this.started) return;
    this.started = true;
    try { await this.initialized; this.background(); }
    catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not open note search.';
      throw error;
    }
  }
  async search(value: unknown): Promise<NotesSearchResponse> {
    const request = notesSearchRequest(value);
    await this.initialized;
    if (this.stopped) throw new Error('Note search is closed.');
    if (request.refresh) this.refresh();
    const result = await this.worker.request<Pick<NotesSearchResponse, 'hits' | 'folders' | 'total' | 'nextOffset' | 'version'>>({ type: 'query', request });
    return { ...result, ...this.status(), hits: result.hits.filter(hit => !this.blocked.has(hit.id)) };
  }
  private background() {
    if (this.stopped || this.syncing) return;
    void this.synchronize().catch(() => { /* Reported by search; retried by the next refresh event. */ });
  }
  refresh() {
    if (this.stopped) return;
    this.dirty = true;
    ++this.epoch;
    this.background();
  }
  async synchronize(): Promise<void> {
    await this.initialized;
    if (this.stopped) return;
    if (this.syncing) return this.syncing;
    this.started = true;
    this.dirty = false;
    const epoch = this.epoch;
    this.syncing = this.update(epoch).catch(async error => {
      // Do not serve cached private text after source access fails.
      await this.worker.request({ type: 'clear' });
      this.ready = false;
      this.error = error instanceof Error ? error.message : 'Could not update note search.';
    }).finally(() => {
      this.syncing = null;
      if (this.epoch !== epoch && !this.stopped) { this.dirty = true; this.background(); }
    });
    return this.syncing;
  }
  private async update(epoch: number) {
    const current = () => !this.stopped && epoch === this.epoch;
    this.error = null; this.completed = 0; this.pending = 0;
    const folders = await this.source.folders();
    if (!current()) return;
    const previous = (await this.worker.request<{ notes: IndexedNote[] }>({ type: 'catalog' })).notes;
    const old = new Map(previous.map(note => [note.id, note]));
    const found = new Map<string, { folderId: string; note: AppleNoteSummary }>();
    const failures: string[] = [];
    for (const folder of folders) {
      if (!current()) return;
      try {
        let offset: number | null = 0;
        while (offset !== null) {
          const page: AppleNotesPage = await this.source.list(folder.id, offset);
          if (!current()) return;
          for (const note of page.notes) found.set(note.id, { folderId: folder.id, note });
          if (page.nextOffset !== null && page.nextOffset <= offset) throw new Error('Invalid note list pagination.');
          offset = page.nextOffset;
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AppleNotes:permission') throw error;
        failures.push(`${folder.account} / ${folder.path}`);
      }
    }
    if (!current()) return;
    await this.worker.request({ type: 'remove', ids: previous.filter(note => !found.has(note.id)).map(note => note.id) });
    this.pending = found.size;
    for (const { folderId, note } of found.values()) {
      if (!current()) return;
      const cached = old.get(note.id);
      const unchanged = !!note.modifiedAt && cached?.modifiedAt === note.modifiedAt && cached.title === note.title
        && cached.folderId === folderId && cached.locked === note.locked && cached.bodyReady;
      if (!unchanged) {
        // Remove outdated text before fetching a replacement; failures cannot revive it.
        await this.worker.request({ type: 'remove', ids: [note.id] });
        let value: AppleNoteSummary & { plaintext?: string } = { ...note, plaintext: '' };
        let bodyReady = note.locked;
        if (!note.locked) {
          try {
            const loaded = await this.source.read(note.id);
            if (!current()) return;
            if (loaded.id !== note.id || loaded.locked || loaded.modifiedAt !== note.modifiedAt) {
              failures.push(note.title); this.completed++; continue;
            }
            value = loaded; bodyReady = true;
          } catch (error) {
            if (error instanceof Error && error.name === 'AppleNotes:permission') throw error;
            failures.push(note.title);
          }
        }
        if (!current()) return;
        await this.worker.request({ type: 'put', folderId, note: value, bodyReady });
      }
      this.blocked.delete(note.id);
      this.completed++;
    }
    if (!current()) return;
    await this.worker.request({ type: 'complete', folders });
    this.ready = true;
    this.error = failures.length ? `Search incomplete: ${failures.length} notes or folders could not be indexed. Refresh to retry.` : null;
  }
  async invalidate(id?: string) {
    ++this.epoch; this.dirty = true;
    if (id) this.blocked.add(id);
    await this.initialized;
    if (id && !this.stopped) await this.worker.request({ type: 'remove', ids: [id] });
    if (this.started) this.background();
  }
  async stop() {
    this.stopped = true; ++this.epoch;
    await this.initialized.catch(() => undefined);
    await this.syncing?.catch(() => undefined);
    await this.worker.close();
  }
}
