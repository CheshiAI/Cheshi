import { appleNoteCreateInput, appleNotesId, APPLE_NOTES_SAVE_UNKNOWN_MESSAGE, type AppleNoteCreateInput, type AppleNotesApi, type AppleNotesFolder } from '../../../../shared/apple-notes';
import type { AppleNoteDocument } from '../../../../shared/apple-notes-document';
import type { NoteDraftState } from './appleNotesDraft';

function assertCreatedDocument(document: AppleNoteDocument, expectedId: string) {
  if (document.id !== expectedId) throw new Error('Unexpected created note');
}

export function createNewNoteDraft(folder: AppleNotesFolder) {
  // This blank document is local editor state, never an identifier sent to Notes.
  const original: AppleNoteDocument = { id: '', title: '', plaintext: '', html: '<p></p>',
    modifiedAt: '', locked: false, attachmentCount: 0 };
  let state: NoteDraftState = { original, title: '', html: original.html, initialHtml: original.html,
    dirty: false, saving: false, error: null, blocked: false, saved: false };
  const listeners = new Set<() => void>();
  const patch = (value: Partial<NoteDraftState>) => { state = { ...state, ...value }; listeners.forEach(listener => listener()); };
  return {
    folder,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(title: string, html: string) {
      if (!state.saving && !state.createdId && !state.blocked) patch({ title, html, dirty: html !== original.html });
    },
    async save(api: Pick<AppleNotesApi, 'create' | 'document'>) {
      if (state.saving || state.blocked || !state.title.trim()) return null;
      if (state.saved) return state.original;
      let request: AppleNoteCreateInput | undefined;
      if (!state.createdId) {
        try { request = appleNoteCreateInput({ folderId: folder.id, title: state.title.trim(), body: '', html: state.html, htmlIncludesTitle: true }); }
        catch { patch({ error: 'This note cannot be saved. Check the title, content size and formatting.' }); return null; }
      }
      patch({ saving: true, error: null });
      try {
        if (request) {
          const result = await api.create(request);
          if (result.ok !== true) {
            patch({ error: result.error.message, blocked: result.error.code === 'save-unknown' });
            return null;
          }
          patch({ createdId: appleNotesId(result.value.id) });
        }
        const document = await api.document(state.createdId!);
        assertCreatedDocument(document, state.createdId!);
        patch({ original: document, dirty: false, saved: true });
        return document;
      } catch {
        patch(state.createdId
          ? { error: 'The note was created. Press Save to retry loading it.', blocked: false }
          : { error: APPLE_NOTES_SAVE_UNKNOWN_MESSAGE, blocked: true });
      } finally { patch({ saving: false }); }
      return null;
    },
  };
}

// One in-memory compose session survives leaving and returning to Memo.
let pendingDraft: ReturnType<typeof createNewNoteDraft> | null = null;
export function getNewNoteDraft() { return pendingDraft; }
export function startNewNoteDraft(folder: AppleNotesFolder) {
  return pendingDraft ??= createNewNoteDraft(folder);
}
export function releaseNewNoteDraft(draft: ReturnType<typeof createNewNoteDraft>) {
  if (pendingDraft === draft && !draft.getSnapshot().saving) pendingDraft = null;
}
