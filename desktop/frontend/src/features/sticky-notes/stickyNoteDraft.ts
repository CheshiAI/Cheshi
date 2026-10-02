import type { StickyNoteContent } from '../../../../shared/sticky-notes';

export const STICKY_NOTE_SAVE_DELAY = 500;
export interface StickyNoteSaveState { saving: boolean; pending: boolean; error: string | null }

/** Save after typing pauses; explicit flush drains all edits before close or quit. */
export class StickyNoteDraft {
  private value: StickyNoteContent;
  private revision = 0;
  private savedRevision = 0;
  private flight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly save: (content: StickyNoteContent) => Promise<void>;
  private readonly report: (state: StickyNoteSaveState) => void;

  constructor(content: StickyNoteContent, save: (content: StickyNoteContent) => Promise<void>, report: (state: StickyNoteSaveState) => void) {
    this.value = { ...content }; this.save = save; this.report = report;
  }

  get dirty() { return this.revision !== this.savedRevision; }

  private cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  update(value: StickyNoteContent) {
    if (this.disposed) return;
    this.value = { ...value };
    this.revision++;
    this.cancelTimer();
    this.report({ saving: !!this.flight, pending: true, error: null });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.saveWhenIdle().catch(() => undefined);
    }, STICKY_NOTE_SAVE_DELAY);
  }

  private async saveWhenIdle() {
    if (this.flight) await this.flight;
    if (!this.disposed && this.timer === null) await this.persist();
  }

  private persist(): Promise<void> {
    if (this.flight) return this.flight;
    if (!this.dirty) return Promise.resolve();
    const revision = this.revision;
    const value = { ...this.value };
    this.report({ saving: true, pending: true, error: null });
    this.flight = Promise.resolve().then(() => this.save(value)).then(() => {
      this.savedRevision = revision;
      this.report({ saving: false, pending: this.dirty, error: null });
    }, error => {
      this.report({ saving: false, pending: true, error: error instanceof Error ? error.message : 'Could not save this note.' });
      throw error;
    }).finally(() => { this.flight = null; });
    return this.flight;
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.flight) await this.flight;
    while (this.dirty) { this.cancelTimer(); await this.persist(); }
  }

  dispose() { this.disposed = true; this.cancelTimer(); }
}
