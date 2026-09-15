import {
  appleNote, appleNoteCreated, appleNoteCreateInput, appleNotesFolders, appleNotesId, appleNotesOffset, appleNotesPage, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE,
} from '../shared/apple-notes.ts';
import type { AppleNotesErrorCode, AppleNotesReply } from '../shared/apple-notes.ts';
import { appleNotesScript, type AppleNotesCommand } from './apple-notes-script.mts';
import { AppleNotesProcessError, runAppleNotesScript } from './apple-notes-process.mts';

const ERROR_MESSAGES: Record<AppleNotesErrorCode, string> = {
  unsupported: 'Apple Notes is available on macOS only.',
  permission: 'Allow Cheshi to control Notes in System Settings → Privacy & Security → Automation, then try again.',
  locked: 'This note is password protected. Choose an unlocked note.',
  'not-found': 'This note or folder is no longer available. Refresh the list and try again.',
  timeout: 'Notes did not respond in time. Check any macOS permission prompt, then try again.',
  'save-unknown': APPLE_NOTES_SAVE_UNKNOWN_MESSAGE,
  invalid: 'The Apple Notes data is invalid or too large. Choose a smaller note or folder.',
  unavailable: 'Apple Notes is unavailable. Open Notes to check your accounts and permissions, then try again.',
};

interface AppleNotesServiceOptions {
  platform?: NodeJS.Platform;
  execute?: (source: string) => Promise<string>;
}

export class AppleNotesService {
  private readonly platform: NodeJS.Platform;
  private readonly execute: (source: string) => Promise<string>;

  constructor(options: AppleNotesServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? runAppleNotesScript;
  }

  folders() { return this.request(() => ({ action: 'folders' }), appleNotesFolders); }
  list(folderId: unknown, offset: unknown = 0) {
    return this.request(() => ({ action: 'list', folderId: appleNotesId(folderId), offset: appleNotesOffset(offset) }), appleNotesPage);
  }
  read(noteId: unknown) { return this.request(() => ({ action: 'read', noteId: appleNotesId(noteId) }), appleNote); }
  create(input: unknown) { return this.request(() => ({ action: 'create', ...appleNoteCreateInput(input) }), appleNoteCreated); }

  private async request<T>(command: () => AppleNotesCommand, parse: (value: unknown) => T): Promise<AppleNotesReply<T>> {
    const fail = (code: AppleNotesErrorCode): AppleNotesReply<T> => ({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });
    if (this.platform !== 'darwin') return fail('unsupported');
    let request: AppleNotesCommand;
    try { request = command(); }
    catch { return fail('invalid'); }
    try {
      const response: unknown = JSON.parse(await this.execute(appleNotesScript(request)));
      if (!response || typeof response !== 'object' || Array.isArray(response)) return fail(request.action === 'create' ? 'save-unknown' : 'invalid');
      if ('ok' in response && response.ok === true && 'value' in response) return { ok: true, value: parse(response.value) };
      if ('ok' in response && response.ok === false && 'code' in response
        && typeof response.code === 'string' && Object.hasOwn(ERROR_MESSAGES, response.code)) {
        return fail(response.code as AppleNotesErrorCode);
      }
      return fail(request.action === 'create' ? 'save-unknown' : 'invalid');
    } catch (error) {
      if (request.action === 'create') return fail('save-unknown');
      if (error instanceof AppleNotesProcessError) return fail(error.reason === 'timeout' ? 'timeout' : 'unavailable');
      return fail('invalid');
    }
  }
}
