import type { WindowAppearanceState } from './window-appearance.ts';

export const STICKY_NOTES_CHANNEL = 'cheshi:sticky-notes';
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
  updatedAt: number;
  pinned: boolean;
  bounds: StickyNoteBounds | null;
}
export interface StickyNoteSummary { id: string; title: string; preview: string; updatedAt: number }
export interface StickyNoteDeleteResult { deletedIds: string[]; failedIds: string[] }
export type StickyNoteRequest = { kind: 'close' } | { kind: 'resume' } | { kind: 'flush'; token: string };
export interface StickyNotesApi {
  read(): Promise<{ note: StickyNote | null; shortcutAvailable: boolean; listShortcutAvailable: boolean }>;
  save(content: StickyNoteContent): Promise<void>;
  list(): Promise<StickyNoteSummary[]>;
  create(): Promise<void>;
  open(id: string): Promise<void>;
  pin(enabled: boolean): Promise<void>;
  close(): Promise<void>;
  delete(): Promise<void>;
  deleteSelected(ids: string[]): Promise<StickyNoteDeleteResult>;
  onChanged(listener: () => void): () => void;
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
  return { ...stickyNoteContent(input), id: stickyNoteId(input.id), updatedAt: input.updatedAt,
    pinned: input.pinned, bounds: stickyNoteBounds(input.bounds) };
}
