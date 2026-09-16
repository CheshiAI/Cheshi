import { getNewNoteDraft } from './appleNotesNewDraft';
import type { AppleNotesApi } from '../../../../shared/apple-notes';
import { APPLE_NOTES_UPDATE_UNKNOWN_MESSAGE, noteDocumentReadOnlyReason, type AppleNoteDocument } from '../../../../shared/apple-notes-document';

export interface NoteDraftState {
  original: AppleNoteDocument;
  title: string;
  html: string;
  initialHtml: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  blocked: boolean;
  saved: boolean;
  createdId?: string;
}

export interface NoteEditorDraft {
  getSnapshot: () => NoteDraftState;
  subscribe: (listener: () => void) => () => void;
  edit: (title: string, html: string) => void;
  save: (api: AppleNotesApi) => Promise<AppleNoteDocument | null>;
  discard?: () => void;
  rebase?: (original: AppleNoteDocument, initialHtml: string) => void;
}

export function createNoteDraft(original: AppleNoteDocument, html: string) {
  let state: NoteDraftState = { original, title: original.title, html, initialHtml: html,
    dirty: false, saving: false, error: null, blocked: false, saved: false };
  const listeners = new Set<() => void>();
  const patch = (value: Partial<NoteDraftState>) => { state = { ...state, ...value }; listeners.forEach(listener => listener()); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(title: string, html: string) {
      if (state.saving || noteDocumentReadOnlyReason(state.original)) return;
      patch({ title, html, dirty: html !== state.initialHtml, saved: false });
    },
    discard() {
      if (state.saving) return;
      patch({ title: state.original.title, html: state.initialHtml, dirty: false, error: null, saved: false });
    },
    rebase(original: AppleNoteDocument, initialHtml: string) {
      // Explicitly called only after the user reviewed the newest original.
      // Keep the draft and compare against that version on the next save.
      if (!state.saving) patch({ original, initialHtml, blocked: false, error: null, dirty: true });
    },
    async save(api: Pick<AppleNotesApi, 'update'>) {
      if (!state.dirty || state.saving || state.blocked || !state.title.trim() || noteDocumentReadOnlyReason(state.original)) return null;
      patch({ saving: true, error: null, saved: false });
      try {
        const result = await api.update({ noteId: state.original.id, title: state.title, html: state.html, htmlIncludesTitle: true,
          expectedHtml: state.original.html, expectedModifiedAt: state.original.modifiedAt, expectedTitle: state.original.title });
        if (result.ok && result.value.id === state.original.id) {
          patch({ original: result.value, title: result.value.title, initialHtml: state.html, dirty: false, saved: true });
          return result.value;
        }
        const error = result.ok ? { code: 'update-unknown', message: APPLE_NOTES_UPDATE_UNKNOWN_MESSAGE } : result.error;
        patch({ error: error.message, blocked: ['conflict', 'update-unknown', 'not-found', 'read-only', 'locked'].includes(error.code) });
      } catch {
        patch({ error: APPLE_NOTES_UPDATE_UNKNOWN_MESSAGE, blocked: true });
      } finally { patch({ saving: false }); }
      return null;
    },
  };
}

// Memory-only drafts survive navigation away from Memo. No personal note contents
// are written to localStorage or an unencrypted temporary file.
const drafts = new Map<string, ReturnType<typeof createNoteDraft>>();
export function retainedNoteDraft(original: AppleNoteDocument, html: string) {
  const previous = drafts.get(original.id);
  if (previous && (previous.getSnapshot().dirty || previous.getSnapshot().saving || previous.getSnapshot().blocked)) return previous;
  for (const [id, draft] of drafts) {
    const state = draft.getSnapshot();
    if (!state.dirty && !state.saving && !state.blocked) drafts.delete(id);
  }
  const draft = createNoteDraft(original, html);
  drafts.set(original.id, draft);
  return draft;
}

let unloadGuardInstalled = false;
export function protectNoteDraftsOnClose() {
  if (unloadGuardInstalled) return;
  unloadGuardInstalled = true;
  // Application-lifetime listener: a draft can outlive the mounted Memo view.
  window.addEventListener('beforeunload', event => {
    const pending = getNewNoteDraft()?.getSnapshot();
    if (!pending?.dirty && !pending?.saving && ![...drafts.values()].some(draft => draft.getSnapshot().dirty || draft.getSnapshot().saving)) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
