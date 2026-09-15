import type { IpcRenderer } from 'electron';
import {
  appleNote, appleNoteCreated, appleNoteCreateInput, appleNotesFolders, appleNotesId, appleNotesOffset, appleNotesPage, readAppleNotesReply,
  appleNotesReply, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE,
} from '../shared/apple-notes.ts';
import type { AppleNotesApi } from '../shared/apple-notes.ts';

export function createAppleNotesApi(ipc: Pick<IpcRenderer, 'invoke'>, platform: string): AppleNotesApi {
  return {
    available: platform === 'darwin',
    folders: async () => readAppleNotesReply(await ipc.invoke('cheshi:apple-notes-folders'), appleNotesFolders),
    list: async (folderId, offset = 0) => readAppleNotesReply(
      await ipc.invoke('cheshi:apple-notes-list', appleNotesId(folderId), appleNotesOffset(offset)), appleNotesPage),
    read: async (noteId) => readAppleNotesReply(await ipc.invoke('cheshi:apple-notes-read', appleNotesId(noteId)), appleNote),
    create: async (input) => {
      const request = appleNoteCreateInput(input);
      try {
        // Keep save outcomes as plain data across contextBridge. Thrown Error
        // properties are not a reliable channel for duplicate-save protection.
        return appleNotesReply(await ipc.invoke('cheshi:apple-notes-create', request), appleNoteCreated);
      } catch {
        return { ok: false, error: { code: 'save-unknown', message: APPLE_NOTES_SAVE_UNKNOWN_MESSAGE } };
      }
    },
  };
}
