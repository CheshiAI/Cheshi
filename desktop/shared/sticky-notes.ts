import type { WindowAppearanceState } from './window-appearance.ts';

export const STICKY_NOTES_CHANNEL = 'cheshi:sticky-notes';
export const STICKY_NOTES_LIBRARY_CHANNEL = 'cheshi:sticky-notes-library';
export const STICKY_NOTES_SHORTCUT = 'CommandOrControl+Shift+N';
export const STICKY_NOTES_LIST_SHORTCUT = 'CommandOrControl+Shift+M';
export const STICKY_NOTE_TEXT_LIMIT = 200_000;

export interface StickyNoteBounds { x: number; y: number; width: number; height: number }
export interface StickyNoteContent { title: string; text: string }
export function hasStickyNoteContent(note: StickyNoteContent): boolean {
  return note.title.trim().length > 0 || note.text.trim().length > 0;
}
export interface StickyNote extends StickyNoteContent {
  id: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  bounds: StickyNoteBounds | null;
}
export interface StickyNoteSummary { id: string; title: string; preview: string; createdAt: number; updatedAt: number }
export interface StickyNoteDeleteResult { deletedIds: string[]; failedIds: string[] }
export type StickyNoteRequest = { kind: 'close' } | { kind: 'resume' } | { kind: 'flush'; token: string } | { kind: 'rename'; token: string; title: string };
export interface StickyNotesLibraryApi {
  list(query?: string): Promise<StickyNoteSummary[]>;
  rename(id: string, title: string): Promise<void>;
  create(): Promise<void>;
  open(id: string): Promise<void>;
  deleteSelected(ids: string[]): Promise<StickyNoteDeleteResult>;
  onChanged(listener: () => void): () => void;
}
export interface WorkspaceNotesApi extends StickyNotesLibraryApi {
  onOpenListRequested(listener: () => void): () => void;
}
export interface StickyNotesApi extends StickyNotesLibraryApi {
  read(): Promise<{ note: StickyNote | null; shortcutAvailable: boolean; listShortcutAvailable: boolean }>;
  save(content: StickyNoteContent): Promise<void>;
  openList(): Promise<void>;
  pin(enabled: boolean): Promise<void>;
  close(): Promise<void>;
  delete(): Promise<void>;
  acknowledge(token: string, error?: string): Promise<void>;
  onRequest(listener: (request: StickyNoteRequest) => void): () => void;
  appearance(): Promise<WindowAppearanceState>;
  onAppearance(listener: (state: WindowAppearanceState) => void): () => void;
}

export function stickyNoteId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    throw new TypeError('Invalid note ID.');
  }
  return value;
}

export function stickyNoteIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new TypeError('Select between 1 and 500 notes.');
  return [...new Set(value.map(stickyNoteId))];
}

export function stickyNoteContent(value: unknown): StickyNoteContent {
  const input = value as Partial<StickyNoteContent> | null;
  if (!input || typeof input.title !== 'string' || input.title.length > 120
    || typeof input.text !== 'string' || input.text.length > STICKY_NOTE_TEXT_LIMIT) {
    throw new TypeError('Invalid note content.');
  }
  return { title: input.title, text: input.text };
}

export function stickyNoteBounds(value: unknown): StickyNoteBounds | null {
  if (value === null) return null;
  const bounds = value as StickyNoteBounds | null;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)
    || bounds.width < 280 || bounds.height < 220 || bounds.width > 20_000 || bounds.height > 20_000) {
    throw new TypeError('Invalid note window bounds.');
  }
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

export function parseStickyNote(value: unknown): StickyNote {
  const input = value as StickyNote | null;
  if (!input || (input.pinned !== true && input.pinned !== false)
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) throw new TypeError('Invalid saved note.');
  const createdAt = input.createdAt === undefined ? input.updatedAt : input.createdAt;
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Invalid note creation date.');
  return { ...stickyNoteContent(input), createdAt, id: stickyNoteId(input.id), updatedAt: input.updatedAt,
    pinned: input.pinned, bounds: stickyNoteBounds(input.bounds) };
}

export function stickyNoteTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new TypeError('Enter a title between 1 and 120 characters.');
  return value.trim();
}

export function stickyNoteQuery(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > STICKY_NOTE_TEXT_LIMIT) throw new TypeError('Invalid note search.');
  return value.trim().toLocaleLowerCase();
}

export function stickyNoteRename(value: unknown): { id: string; title: string } {
  const input = value as { id?: unknown; title?: unknown } | null;
  return { id: stickyNoteId(input?.id), title: stickyNoteTitle(input?.title) };
}
