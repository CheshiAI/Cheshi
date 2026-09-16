import type { IpcRenderer } from 'electron';
import {
  appleNote, appleNoteCreated, appleNoteCreateInput, appleNotesFolders, appleNotesId, appleNotesOffset, appleNotesPage, readAppleNotesReply,
  appleNotesReply, appleNoteDeleted, appleNotesForceRefresh, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE, APPLE_NOTES_DELETE_UNKNOWN_MESSAGE,
} from '../shared/apple-notes.ts';
import type { AppleNotesApi } from '../shared/apple-notes.ts';
import { appleNoteDocument, appleNoteUpdateInput, APPLE_NOTES_UPDATE_UNKNOWN_MESSAGE } from '../shared/apple-notes-document.ts';

export function createAppleNotesApi(ipc: Pick<IpcRenderer, 'invoke'>, platform: string): AppleNotesApi {
  return {
    available: platform === 'darwin',
    folders: async (forceRefresh) => readAppleNotesReply(
      await ipc.invoke('cheshi:apple-notes-folders', ...appleNotesForceRefresh(forceRefresh) ? [true] : []), appleNotesFolders),
    list: async (folderId, offset = 0) => readAppleNotesReply(
      await ipc.invoke('cheshi:apple-notes-list', appleNotesId(folderId), appleNotesOffset(offset)), appleNotesPage),
    read: async (noteId) => readAppleNotesReply(await ipc.invoke('cheshi:apple-notes-read', appleNotesId(noteId)), appleNote),
    document: async (noteId) => readAppleNotesReply(await ipc.invoke('cheshi:apple-notes-document', appleNotesId(noteId)), appleNoteDocument),
    update: async (input) => {
      const request = appleNoteUpdateInput(input);
      try {
        return appleNotesReply(await ipc.invoke('cheshi:apple-notes-update', request), value => {
          const document = appleNoteDocument(value);
          if (document.id !== request.noteId) throw new TypeError('Unexpected updated note.');
          return document;
        });
      } catch {
        return { ok: false, error: { code: 'update-unknown', message: APPLE_NOTES_UPDATE_UNKNOWN_MESSAGE } };
      }
    },
    delete: async (noteId) => {
      const id = appleNotesId(noteId);
      try {
        return appleNotesReply(await ipc.invoke('cheshi:apple-notes-delete', id), value => appleNoteDeleted(value, id));
      } catch {
        return { ok: false, error: { code: 'delete-unknown', message: APPLE_NOTES_DELETE_UNKNOWN_MESSAGE } };
      }
    },
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
