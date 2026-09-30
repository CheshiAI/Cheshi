import {
  appleNote, appleNoteCreated, appleNoteCreateInput, appleNoteDeleted, appleNotesFolders, appleNotesId, appleNotesOffset, appleNotesPage, appleNotesForceRefresh, appleNotesOpenResult, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE, APPLE_NOTES_DELETE_UNKNOWN_MESSAGE,
} from '../shared/apple-notes.ts';
import type { AppleNotesErrorCode, AppleNotesReply } from '../shared/apple-notes.ts';
import { appleNotesScript, type AppleNotesCommand } from './apple-notes-script.mts';
import { AppleNotesProcessError, runAppleNotesScript } from './apple-notes-process.mts';
import { AppleNotesSearch } from './apple-notes-search.mts';
import { notesSearchRequest } from '../shared/apple-notes-search.ts';
import type { NotesSearchResponse, NotesSearchStatus } from '../shared/apple-notes-search.ts';
import { readAppleNotesReply } from '../shared/apple-notes.ts';
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
  conflict: 'The original changed in Apple Notes. Review it before saving your draft.',
  'read-only': 'The original cannot be edited because it contains attachments or unsupported formatting.',
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
  searchFilename?: string;
  activationEvents?: {
    on(event: 'did-become-active' | 'did-resign-active', listener: () => void): unknown;
    off(event: 'did-become-active' | 'did-resign-active', listener: () => void): unknown;
  };
}

export class AppleNotesService {
  private readonly platform: NodeJS.Platform;
  private readonly execute: (source: string) => Promise<string>;
  private readonly cache: AppleNotesCache;
  private readonly searchFilename: string | undefined;
  private searchIndex: AppleNotesSearch | null = null;
  private readonly activationEvents: AppleNotesServiceOptions['activationEvents'];
  private activationTimer: ReturnType<typeof setTimeout> | null = null;
  private watchingActivation = false;
  private inactive = false;
  private stopped = false;
  private readonly onInactive = () => {
    this.inactive = true;
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = null;
  };
  private readonly onActive = () => {
    if (this.stopped || !this.inactive) return;
    this.inactive = false;
    // Coalesce rapid app switches; this one-shot timer never schedules another scan.
    this.activationTimer = setTimeout(() => {
      this.activationTimer = null;
      if (!this.stopped) this.searchIndex?.refresh();
    }, 250);
  };
  private readonly updates = new Map<string, Promise<unknown>>();

  constructor(options: AppleNotesServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? runAppleNotesScript;
    this.cache = new AppleNotesCache(options.cache);
    this.searchFilename = options.searchFilename;
    this.activationEvents = options.activationEvents;
  }

  async search(value: unknown): Promise<AppleNotesReply<NotesSearchResponse>> {
    if (this.platform !== 'darwin') return failure('unsupported');
    let request: ReturnType<typeof notesSearchRequest>;
    try { request = notesSearchRequest(value); } catch { return failure('invalid'); }
    if (!this.searchFilename) return failure('unavailable');
    try { return { ok: true, value: await this.ensureSearch().search(request) }; }
    catch { return failure('unavailable'); }
  }
  private ensureSearch() {
    if (!this.searchFilename) throw new Error('Note search storage is unavailable.');
    return this.searchIndex ??= new AppleNotesSearch(this.searchFilename, {
      folders: async () => readAppleNotesReply(await this.executeRequest({ action: 'folders' }, appleNotesFolders), appleNotesFolders),
      list: async (folderId, offset) => readAppleNotesReply(await this.executeRequest({ action: 'list', folderId, offset }, appleNotesPage), appleNotesPage),
      read: async noteId => readAppleNotesReply(await this.executeRequest({ action: 'read', noteId }, appleNote), appleNote),
    });
  }
  async start() {
    if (this.stopped || this.platform !== 'darwin' || !this.searchFilename) return;
    if (!this.watchingActivation) {
      this.activationEvents?.on('did-resign-active', this.onInactive);
      this.activationEvents?.on('did-become-active', this.onActive);
      this.watchingActivation = true;
    }
    await this.ensureSearch().start();
  }
  searchStatus(): AppleNotesReply<NotesSearchStatus> {
    return { ok: true, value: this.searchIndex?.status() ?? { state: 'idle', completed: 0, pending: 0, error: null } };
  }
  async stop() {
    this.stopped = true;
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = null;
    this.activationEvents?.off('did-resign-active', this.onInactive);
    this.activationEvents?.off('did-become-active', this.onActive);
    await this.searchIndex?.stop();
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
  open(noteId: unknown) { return this.request(() => ({ action: 'open', noteId: appleNotesId(noteId) }), appleNotesOpenResult); }
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
    if (request.action === 'document' || request.action === 'open') return this.executeRequest(request, parse);
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
    const changedId = request.action === 'create' ? undefined : request.noteId;
    // Search failures must not turn a confirmed native mutation into an uncertain save.
    await this.searchIndex?.invalidate(changedId).catch(() => undefined);
    try { return await this.executeRequest(request, parse); }
    finally { invalidate(); await this.searchIndex?.invalidate(changedId).catch(() => undefined); }
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
