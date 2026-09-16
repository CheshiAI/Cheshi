import {
  appleNote, appleNoteCreated, appleNoteCreateInput, appleNoteDeleted, appleNotesFolders, appleNotesId, appleNotesOffset, appleNotesPage, appleNotesForceRefresh, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE, APPLE_NOTES_DELETE_UNKNOWN_MESSAGE,
} from '../shared/apple-notes.ts';
import type { AppleNotesErrorCode, AppleNotesReply } from '../shared/apple-notes.ts';
import { appleNotesScript, type AppleNotesCommand } from './apple-notes-script.mts';
import { AppleNotesProcessError, runAppleNotesScript } from './apple-notes-process.mts';
import { AppleNotesCache, type AppleNotesCacheOptions } from './apple-notes-cache.mts';
import { appleNoteDocument, appleNoteUpdateInput, isEditableNoteHtml, APPLE_NOTES_UPDATE_UNKNOWN_MESSAGE } from '../shared/apple-notes-document.ts';

const ERROR_MESSAGES: Record<AppleNotesErrorCode, string> = {
  unsupported: 'Apple Notes is available on macOS only.',
  permission: 'Allow Cheshi to control Notes in System Settings → Privacy & Security → Automation, then try again.',
  locked: 'This note is password protected. Choose an unlocked note.',
  'not-found': 'This note or folder is no longer available. Refresh the list and try again.',
  timeout: 'Notes did not respond in time. Check any macOS permission prompt, then try again.',
  'save-unknown': APPLE_NOTES_SAVE_UNKNOWN_MESSAGE,
  'delete-unknown': APPLE_NOTES_DELETE_UNKNOWN_MESSAGE,
  'update-unknown': APPLE_NOTES_UPDATE_UNKNOWN_MESSAGE,
  conflict: 'Apple 메모에서 원본이 변경되었습니다. 초안을 유지한 채 원본을 확인하세요.',
  'read-only': '첨부파일 또는 지원하지 않는 서식이 있어 원본을 수정할 수 없습니다.',
  invalid: 'The Apple Notes data is invalid or too large. Choose a smaller note or folder.',
  unavailable: 'Apple Notes is unavailable. Open Notes to check your accounts and permissions, then try again.',
};

function failure<T>(code: AppleNotesErrorCode): AppleNotesReply<T> {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}

interface AppleNotesServiceOptions {
  platform?: NodeJS.Platform;
  execute?: (source: string) => Promise<string>;
  cache?: AppleNotesCacheOptions;
}

export class AppleNotesService {
  private readonly platform: NodeJS.Platform;
  private readonly execute: (source: string) => Promise<string>;
  private readonly cache: AppleNotesCache;
  private readonly updates = new Map<string, Promise<unknown>>();

  constructor(options: AppleNotesServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? runAppleNotesScript;
    this.cache = new AppleNotesCache(options.cache);
  }

  folders(forceRefresh: unknown = false) {
    return this.request(() => {
      if (appleNotesForceRefresh(forceRefresh)) this.cache.invalidate();
      return { action: 'folders' };
    }, appleNotesFolders);
  }
  list(folderId: unknown, offset: unknown = 0) {
    return this.request(() => ({ action: 'list', folderId: appleNotesId(folderId), offset: appleNotesOffset(offset) }), appleNotesPage);
  }
  read(noteId: unknown) { return this.request(() => ({ action: 'read', noteId: appleNotesId(noteId) }), appleNote); }
  document(noteId: unknown) { return this.request(() => ({ action: 'document', noteId: appleNotesId(noteId) }), appleNoteDocument); }
  async update(input: unknown) {
    let request: ReturnType<typeof appleNoteUpdateInput>;
    try { request = appleNoteUpdateInput(input); }
    catch { return failure<ReturnType<typeof appleNoteDocument>>('invalid'); }
    if (!isEditableNoteHtml(request.expectedHtml)) return failure<ReturnType<typeof appleNoteDocument>>('read-only');
    const previous = this.updates.get(request.noteId);
    const operation = (async () => {
      await previous;
      return this.request(() => ({ action: 'update', ...request }), value => {
        const document = appleNoteDocument(value);
        if (document.id !== request.noteId) throw new TypeError('Unexpected updated note.');
        return document;
      });
    })();
    this.updates.set(request.noteId, operation);
    try { return await operation; }
    finally { if (this.updates.get(request.noteId) === operation) this.updates.delete(request.noteId); }
  }
  create(input: unknown) { return this.request(() => ({ action: 'create', ...appleNoteCreateInput(input) }), appleNoteCreated); }
  delete(noteId: unknown) {
    return this.request(() => ({ action: 'delete', noteId: appleNotesId(noteId) }), value => appleNoteDeleted(value, appleNotesId(noteId)));
  }

  private async request<T>(command: () => AppleNotesCommand, parse: (value: unknown) => T): Promise<AppleNotesReply<T>> {
    if (this.platform !== 'darwin') return failure('unsupported');
    let request: AppleNotesCommand;
    try { request = command(); }
    catch { return failure('invalid'); }
    if (request.action === 'document') return this.executeRequest(request, parse);
    if (request.action !== 'create' && request.action !== 'delete' && request.action !== 'update') {
      return this.cache.read(JSON.stringify(request), () => this.executeRequest(request, parse));
    }
    // Clear on both sides: a read started before or during a mutation must not
    // repopulate the cache after it finishes, including uncertain outcomes.
    const invalidate = () => {
      if (request.action === 'create') this.cache.invalidate();
      else if (request.action === 'delete' || request.action === 'update') {
        const noteKey = JSON.stringify({ action: 'read', noteId: request.noteId });
        // Deletion shifts page offsets. The delete API carries only a note ID,
        // so invalidate list pages conservatively without evicting other bodies
        // or folder metadata. Nothing is fetched until a caller requests it.
        this.cache.invalidate(key => key === noteKey || key.startsWith('{"action":"list",'));
      }
    };
    invalidate();
    try { return await this.executeRequest(request, parse); }
    finally { invalidate(); }
  }

  private async executeRequest<T>(request: AppleNotesCommand, parse: (value: unknown) => T): Promise<AppleNotesReply<T>> {
    const uncertainCode = request.action === 'create' ? 'save-unknown' : request.action === 'delete' ? 'delete-unknown' : request.action === 'update' ? 'update-unknown' : null;
    try {
      const response: unknown = JSON.parse(await this.execute(appleNotesScript(request)));
      if (!response || typeof response !== 'object' || Array.isArray(response)) return failure(uncertainCode ?? 'invalid');
      if ('ok' in response && response.ok === true && 'value' in response) return { ok: true, value: parse(response.value) };
      if ('ok' in response && response.ok === false && 'code' in response
        && typeof response.code === 'string' && Object.hasOwn(ERROR_MESSAGES, response.code)) {
        return failure(response.code as AppleNotesErrorCode);
      }
      return failure(uncertainCode ?? 'invalid');
    } catch (error) {
      if (uncertainCode) return failure(uncertainCode);
      if (error instanceof AppleNotesProcessError) return failure(error.reason === 'timeout' ? 'timeout' : 'unavailable');
      return failure('invalid');
    }
  }
}
