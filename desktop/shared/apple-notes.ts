export const APPLE_NOTES_MAX_BODY_LENGTH = 500_000;
export const APPLE_NOTES_MAX_TITLE_LENGTH = 200;
export const APPLE_NOTES_PAGE_SIZE = 100;
export const APPLE_NOTES_SAVE_UNKNOWN_MESSAGE = 'The save could not be confirmed. Check Apple Notes before saving again to avoid a duplicate.';

export interface AppleNotesFolder {
  id: string;
  name: string;
  account: string;
  path: string;
  isDefault: boolean;
}

export interface AppleNoteSummary {
  id: string;
  title: string;
  modifiedAt: string;
  locked: boolean;
}

export interface AppleNote extends AppleNoteSummary {
  plaintext: string;
}

export interface AppleNotesPage {
  notes: AppleNoteSummary[];
  nextOffset: number | null;
}

export interface AppleNoteCreateInput {
  folderId: string;
  title: string;
  body: string;
}

export interface AppleNoteCreated { id: string; title: string }

export type AppleNotesErrorCode = 'unsupported' | 'permission' | 'locked' | 'not-found'
  | 'timeout' | 'save-unknown' | 'invalid' | 'unavailable';

export type AppleNotesReply<T> = { ok: true; value: T }
  | { ok: false; error: { code: AppleNotesErrorCode; message: string } };

export interface AppleNotesApi {
  available: boolean;
  folders(): Promise<AppleNotesFolder[]>;
  list(folderId: string, offset?: number): Promise<AppleNotesPage>;
  read(noteId: string): Promise<AppleNote>;
  create(input: AppleNoteCreateInput): Promise<AppleNotesReply<AppleNoteCreated>>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Apple Notes response.');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim()) || value.includes('\0')) {
    throw new TypeError(`${label} is invalid or too long.`);
  }
  return value;
}

function literalBoolean(value: unknown): boolean {
  if (value !== true && value !== false) throw new TypeError('Invalid Apple Notes flag.');
  return value;
}

export function appleNotesId(value: unknown): string {
  return text(value, 'Apple Notes identifier', 2_048);
}

export function appleNotesOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid Apple Notes page.');
  return value;
}

export function appleNoteCreateInput(value: unknown): AppleNoteCreateInput {
  const input = record(value);
  return { folderId: appleNotesId(input.folderId),
    title: text(input.title, 'Note title', APPLE_NOTES_MAX_TITLE_LENGTH).trim(),
    body: text(input.body, 'Note body', APPLE_NOTES_MAX_BODY_LENGTH) };
}

export function appleNoteSummary(value: unknown): AppleNoteSummary {
  const item = record(value);
  const modifiedAt = text(item.modifiedAt, 'Note date', 64);
  if (!Number.isFinite(Date.parse(modifiedAt))) throw new TypeError('Invalid note date.');
  return { id: appleNotesId(item.id), title: text(item.title, 'Note title', 10_000, true),
    modifiedAt, locked: literalBoolean(item.locked) };
}

export function appleNote(value: unknown): AppleNote {
  const item = record(value);
  return { ...appleNoteSummary(item), plaintext: text(item.plaintext, 'Note body', APPLE_NOTES_MAX_BODY_LENGTH, true) };
}

export function appleNotesFolders(value: unknown): AppleNotesFolder[] {
  if (!Array.isArray(value) || value.length > 5_000) throw new TypeError('Invalid Apple Notes folders.');
  return value.map(entry => {
    const item = record(entry);
    return { id: appleNotesId(item.id), name: text(item.name, 'Folder name', 10_000),
      account: text(item.account, 'Account name', 10_000), path: text(item.path, 'Folder path', 100_000),
      isDefault: literalBoolean(item.isDefault) };
  });
}

export function appleNotesPage(value: unknown): AppleNotesPage {
  const item = record(value);
  if (!Array.isArray(item.notes) || item.notes.length > APPLE_NOTES_PAGE_SIZE) throw new TypeError('Invalid Apple Notes list.');
  return { notes: item.notes.map(appleNoteSummary), nextOffset: item.nextOffset === null ? null : appleNotesOffset(item.nextOffset) };
}

export function appleNoteCreated(value: unknown): AppleNoteCreated {
  const item = record(value);
  return { id: appleNotesId(item.id), title: text(item.title, 'Note title', 10_000, true) };
}

const ERROR_CODES: readonly string[] = ['unsupported', 'permission', 'locked', 'not-found', 'timeout', 'save-unknown', 'invalid', 'unavailable'];

export function appleNotesReply<T>(value: unknown, parse: (value: unknown) => T): AppleNotesReply<T> {
  const reply = record(value);
  if (reply.ok === true) return { ok: true, value: parse(reply.value) };
  if (reply.ok !== false) throw new TypeError('Invalid Apple Notes reply.');
  const failure = record(reply.error);
  if (typeof failure.code !== 'string' || !ERROR_CODES.includes(failure.code)) throw new TypeError('Invalid Apple Notes error.');
  return { ok: false, error: { code: failure.code as AppleNotesErrorCode, message: text(failure.message, 'Apple Notes error', 1_000) } };
}

export function readAppleNotesReply<T>(value: unknown, parse: (value: unknown) => T): T {
  const reply = appleNotesReply(value, parse);
  if (reply.ok) return reply.value;
  const error = new Error(reply.error.message);
  error.name = `AppleNotes:${reply.error.code}`;
  throw error;
}
