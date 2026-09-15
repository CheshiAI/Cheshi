import type { AppleNote, AppleNoteSummary, AppleNotesApi, AppleNotesFolder } from '../../../../shared/apple-notes';

export function appleNoteAttachment(note: AppleNote): File {
  if (note.locked) throw new Error('Password-protected notes cannot be attached.');
  const name = note.title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ').trim().slice(0, 120) || 'Apple Note';
  return new File([note.plaintext], `${name}.txt`, { type: 'text/plain' });
}

export interface AppleNotesBrowserState {
  folders: AppleNotesFolder[];
  folderId: string;
  notes: AppleNoteSummary[];
  selectedId: string;
  note: AppleNote | null;
  nextOffset: number | null;
  loadingFolders: boolean;
  loadingNotes: boolean;
  loadingNote: boolean;
  error: string | null;
}

// Each request is scoped to the folder/note that started it. Late responses may
// not replace a different preview or revive a dialog after it has closed.
export function createAppleNotesBrowser(api: AppleNotesApi, browse: boolean) {
  let state: AppleNotesBrowserState = { folders: [], folderId: '', notes: [], selectedId: '', note: null,
    nextOffset: null, loadingFolders: false, loadingNotes: false, loadingNote: false, error: null };
  const listeners = new Set<() => void>();
  let active = true;
  let folderRequest = 0;
  let listRequest = 0;
  let noteRequest = 0;
  const update = (patch: Partial<AppleNotesBrowserState>) => {
    if (!active) return;
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const report = (error: unknown) => error instanceof Error ? error.message : 'Apple Notes is unavailable.';

  const loadNotes = async (folderId: string, offset: number, append: boolean) => {
    const request = ++listRequest;
    update({ loadingNotes: true, error: null });
    try {
      const page = await api.list(folderId, offset);
      if (!active || request !== listRequest) return;
      if (page.nextOffset !== null && page.nextOffset <= offset) throw new Error('Apple Notes returned an invalid page. Refresh and try again.');
      const notes = append ? [...state.notes, ...page.notes] : page.notes;
      update({ notes: [...new Map(notes.map(note => [note.id, note])).values()], nextOffset: page.nextOffset });
    } catch (error) {
      if (active && request === listRequest) update({ error: report(error) });
    } finally {
      if (active && request === listRequest) update({ loadingNotes: false });
    }
  };

  const selectFolder = async (folderId: string) => {
    ++listRequest;
    ++noteRequest;
    update({ folderId, notes: [], selectedId: '', note: null, nextOffset: null, loadingNote: false, loadingNotes: false, error: null });
    if (active && browse && folderId) await loadNotes(folderId, 0, false);
  };

  const refresh = async () => {
    active = true;
    const request = ++folderRequest;
    ++listRequest;
    ++noteRequest;
    update({ loadingFolders: true, loadingNotes: false, loadingNote: false, error: null,
      notes: [], selectedId: '', note: null, nextOffset: null });
    try {
      const folders = await api.folders();
      if (!active || request !== folderRequest) return;
      const selected = folders.find(folder => folder.id === state.folderId)
        ?? folders.find(folder => folder.isDefault) ?? folders[0];
      update({ folders, loadingFolders: false });
      await selectFolder(selected?.id ?? '');
    } catch (error) {
      if (active && request === folderRequest) update({ error: report(error), folders: [], folderId: '' });
    } finally {
      if (active && request === folderRequest) update({ loadingFolders: false });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    selectFolder,
    loadMore: async () => {
      if (state.loadingNotes || state.loadingFolders || state.nextOffset === null || !active) return;
      await loadNotes(state.folderId, state.nextOffset, true);
    },
    selectNote: async (id: string) => {
      const request = ++noteRequest;
      const selected = state.notes.find(note => note.id === id);
      update({ selectedId: id, note: null, loadingNote: false, error: null });
      if (!selected || !active) return;
      if (selected.locked) { update({ error: 'This note is password protected. Choose an unlocked note.' }); return; }
      update({ loadingNote: true });
      try {
        const note = await api.read(id);
        if (!active || request !== noteRequest) return;
        if (note.id !== id || note.locked) throw new Error('This note is no longer available to attach. Refresh and try again.');
        update({ note });
      } catch (error) {
        if (active && request === noteRequest) update({ error: report(error) });
      } finally {
        if (active && request === noteRequest) update({ loadingNote: false });
      }
    },
    dispose: () => { active = false; ++folderRequest; ++listRequest; ++noteRequest; },
  };
}
