import { appleNote, appleNotesDate, appleNotesId, APPLE_NOTES_MAX_BODY_LENGTH, APPLE_NOTES_MAX_TITLE_LENGTH, type AppleNote } from './apple-notes.ts';

export interface AppleNoteDocument extends AppleNote {
  html: string;
  attachmentCount: number;
}

export interface AppleNoteUpdateInput {
  noteId: string;
  title: string;
  html: string;
  expectedHtml: string;
  expectedModifiedAt: string;
  expectedTitle: string;
}

export const APPLE_NOTES_UPDATE_UNKNOWN_MESSAGE = '저장 결과를 확인할 수 없습니다. 초안은 유지됩니다. Apple 메모를 확인하고 원본을 다시 불러오세요.';

function htmlText(value: unknown): string {
  if (typeof value !== 'string' || value.length > APPLE_NOTES_MAX_BODY_LENGTH || value.includes('\0')) {
    throw new TypeError('Invalid note HTML.');
  }
  return value;
}

export function appleNoteDocument(value: unknown): AppleNoteDocument {
  const note = appleNote(value);
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.attachmentCount) || Number(record.attachmentCount) < 0) throw new TypeError('Invalid attachment count.');
  return { ...note, html: htmlText(record.html), attachmentCount: Number(record.attachmentCount) };
}

export function appleNoteUpdateInput(value: unknown): AppleNoteUpdateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid note update.');
  const input = value as Record<string, unknown>;
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > APPLE_NOTES_MAX_TITLE_LENGTH
    || /[\r\n\0]/.test(input.title) || typeof input.expectedTitle !== 'string' || input.expectedTitle.length > 10_000) throw new TypeError('Invalid note update.');
  const expectedModifiedAt = appleNotesDate(input.expectedModifiedAt);
  const html = htmlText(input.html);
  if (!isEditableNoteHtml(html)) throw new TypeError('Unsupported note HTML.');
  return { noteId: appleNotesId(input.noteId), title: input.title.trim(), html,
    expectedHtml: htmlText(input.expectedHtml), expectedModifiedAt, expectedTitle: input.expectedTitle };
}

export function appleNoteFontSize(style: string): string | null {
  const match = /^\s*font-size\s*:\s*((?:\d+(?:\.\d+)?|\.\d+)px)\s*;?\s*$/i.exec(style);
  if (!match) return null;
  const size = Number.parseFloat(match[1]!);
  if (!Number.isFinite(size) || size <= 0) return null;
  return match[1]!.toLowerCase();
}

// Deliberately conservative HTML grammar. Reject unknown tags/attributes instead
// of silently dropping Apple Notes content when round-tripping through the editor.
// This is not a general-purpose HTML sanitizer; unsupported documents stay read-only.
export function isEditableNoteHtml(html: string): boolean {
  const tags = new Set(['div', 'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'span']);
  const stack: string[] = [];
  const tokens = html.match(/<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== html) return false;
  for (const token of tokens) {
    if (!token.startsWith('<')) continue;
    const match = /^<(\/?)([a-z][a-z0-9]*)([^<>]*?)(\/?)>$/i.exec(token);
    if (!match) return false;
    const [, closing, rawTag, attributes, selfClosing] = match;
    const tag = rawTag!.toLowerCase();
    if (!tags.has(tag)) return false;
    if (closing) {
      if (attributes!.trim() || selfClosing || stack.pop() !== tag) return false;
      continue;
    }
    let rest = attributes!;
    const seen = new Set<string>();
    while (rest.trim()) {
      const attribute = /^\s+([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(rest);
      if (!attribute) return false;
      const name = attribute[1]!.toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? '';
      if (seen.has(name)) return false;
      seen.add(name);
      const allowed = (tag === 'a' && name === 'href' && /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(value))
        || (tag === 'a' && name === 'target' && value === '_blank')
        || (tag === 'a' && name === 'rel' && /^(?:noopener|noreferrer|nofollow)(?: (?:noopener|noreferrer|nofollow))*$/.test(value))
        || (tag === 'ol' && name === 'start' && /^[1-9]\d{0,5}$/.test(value))
        || (tag === 'code' && name === 'class' && /^language-[\w+-]+$/.test(value))
        || (tag === 'span' && name === 'style' && appleNoteFontSize(value) !== null)
        || (['div', 'span', 'p', 'pre'].includes(tag) && name === 'style' && /^\s*white-space\s*:\s*pre-wrap\s*;?\s*$/i.test(value));
      if (!allowed) return false;
      rest = rest.slice(attribute[0].length);
    }
    if (!['br', 'hr'].includes(tag)) {
      if (selfClosing || stack.length >= 64) return false;
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

export function noteDocumentReadOnlyReason(document: AppleNoteDocument): string | null {
  if (document.locked) return '잠긴 메모는 수정할 수 없습니다.';
  if (document.attachmentCount > 0) return '이미지·첨부파일이 있는 메모는 원본 보호를 위해 읽기 전용입니다.';
  if (!isEditableNoteHtml(document.html)) return '보존할 수 없는 서식이 있어 읽기 전용입니다. Apple 메모에서 수정하세요.';
  return null;
}
