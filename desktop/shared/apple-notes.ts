import { appleNoteHtmlIncludesTitle, isEditableNoteHtml, type AppleNoteDocument, type AppleNoteUpdateInput } from './apple-notes-document.ts';

export const APPLE_NOTES_MAX_BODY_LENGTH = 500_000;
export const APPLE_NOTES_MAX_TITLE_LENGTH = 200;
export const APPLE_NOTES_PAGE_SIZE = 100;
export const APPLE_NOTES_SAVE_UNKNOWN_MESSAGE = 'The save could not be confirmed. Check Apple Notes before saving again to avoid a duplicate.';
export const APPLE_NOTES_DELETE_UNKNOWN_MESSAGE = '삭제 결과를 확인할 수 없습니다. Apple 메모에서 상태를 확인한 뒤 목록을 새로고침하세요.';

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
  createdAt?: string;
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
  html?: string;
  htmlIncludesTitle?: boolean;
}

export interface AppleNoteCreated { id: string; title: string }
export interface AppleNoteDeleted { id: string }

export type AppleNotesErrorCode = 'unsupported' | 'permission' | 'locked' | 'not-found'
  | 'timeout' | 'save-unknown' | 'delete-unknown' | 'update-unknown' | 'conflict' | 'read-only' | 'invalid' | 'unavailable';

export type AppleNotesReply<T> = { ok: true; value: T }
  | { ok: false; error: { code: AppleNotesErrorCode; message: string } };

export interface AppleNotesApi {
  available: boolean;
  folders(forceRefresh?: boolean): Promise<AppleNotesFolder[]>;
  list(folderId: string, offset?: number): Promise<AppleNotesPage>;
  read(noteId: string): Promise<AppleNote>;
  document(noteId: string): Promise<AppleNoteDocument>;
  update(input: AppleNoteUpdateInput): Promise<AppleNotesReply<AppleNoteDocument>>;
  create(input: AppleNoteCreateInput): Promise<AppleNotesReply<AppleNoteCreated>>;
  delete(noteId: string): Promise<AppleNotesReply<AppleNoteDeleted>>;
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

export function appleNotesForceRefresh(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new TypeError('Invalid Apple Notes refresh flag.');
}

export function appleNotesOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid Apple Notes page.');
  return value;
}

export function appleNoteCreateInput(value: unknown): AppleNoteCreateInput {
  const input = record(value);
  const title = text(input.title, 'Note title', APPLE_NOTES_MAX_TITLE_LENGTH).trim();
  if (/[\r\n]/.test(title)) throw new TypeError('Invalid note title.');
  const html = input.html === undefined ? undefined : text(input.html, 'Note HTML', APPLE_NOTES_MAX_BODY_LENGTH, true);
  const htmlIncludesTitle = appleNoteHtmlIncludesTitle(input.htmlIncludesTitle);
  if (htmlIncludesTitle && html === undefined) throw new TypeError('Full note HTML is required.');
  if (html !== undefined && (!isEditableNoteHtml(html) || html.length + (htmlIncludesTitle ? 0 : title.length * 6 + 10) > APPLE_NOTES_MAX_BODY_LENGTH)) {
    throw new TypeError('Unsupported or oversized note HTML.');
  }
  return { folderId: appleNotesId(input.folderId), title,
    body: text(input.body, 'Note body', APPLE_NOTES_MAX_BODY_LENGTH, html !== undefined),
    ...(html === undefined ? {} : { html }), ...(htmlIncludesTitle ? { htmlIncludesTitle: true } : {}) };
}

export function appleNoteSummary(value: unknown): AppleNoteSummary {
  const item = record(value);
  const modifiedAt = appleNotesDate(item.modifiedAt);
  const createdAt = item.createdAt === undefined ? '' : appleNotesDate(item.createdAt);
  return { id: appleNotesId(item.id), title: text(item.title, 'Note title', 10_000, true),
    modifiedAt, ...(createdAt ? { createdAt } : {}), locked: literalBoolean(item.locked) };
}

// An empty string represents an unavailable native timestamp.
export function appleNotesDate(value: unknown): string {
  const date = text(value, 'Note date', 64, true);
  if (date !== '' && !Number.isFinite(Date.parse(date))) throw new TypeError('Invalid note date.');
  return date;
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

export function appleNoteDeleted(value: unknown, expectedId: string): AppleNoteDeleted {
  const id = appleNotesId(record(value).id);
  if (id !== expectedId) throw new TypeError('Unexpected deleted note identifier.');
  return { id };
}

const ERROR_CODES: readonly string[] = ['unsupported', 'permission', 'locked', 'not-found', 'timeout', 'save-unknown', 'delete-unknown', 'update-unknown', 'conflict', 'read-only', 'invalid', 'unavailable'];

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
