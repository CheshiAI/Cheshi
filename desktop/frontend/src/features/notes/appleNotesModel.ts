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
  refreshingNotes: boolean;
  loadingNote: boolean;
  error: string | null;
}

// Each request is scoped to the folder/note that started it. Late responses may
// not replace a different preview or revive a dialog after it has closed.
export function createAppleNotesBrowser(api: AppleNotesApi, browse: boolean, now: () => number = Date.now) {
  let state: AppleNotesBrowserState = { folders: [], folderId: '', notes: [], selectedId: '', note: null,
    nextOffset: null, loadingFolders: false, loadingNotes: false, refreshingNotes: false, loadingNote: false, error: null };
  const folderCache = new Map<string, { notes: AppleNoteSummary[]; nextOffset: number | null; pages: number; expiresAt: number }>();
  const cacheTtlMs = 30_000;
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

  const loadNotes = async (folderId: string, offset: number, append: boolean, background = false) => {
    const request = ++listRequest;
    const cached = folderCache.get(folderId);
    const startedAt = now();
    update({ loadingNotes: !background, refreshingNotes: background, error: null });
    try {
      let notes = append ? [...state.notes] : [];
      let nextOffset: number | null = offset;
      let pages = append ? cached?.pages ?? 1 : 0;
      const pagesToLoad = background ? cached?.pages ?? 1 : 1;
      for (let index = 0; index < pagesToLoad && nextOffset !== null; index += 1) {
        const pageOffset: number = nextOffset;
        const page = await api.list(folderId, pageOffset);
        if (!active || request !== listRequest) return;
        if (page.nextOffset !== null && page.nextOffset <= pageOffset) throw new Error('Apple Notes returned an invalid page. Refresh and try again.');
        notes.push(...page.notes);
        nextOffset = page.nextOffset;
        pages += 1;
      }
      notes = [...new Map(notes.map(note => [note.id, note])).values()];
      folderCache.delete(folderId);
      folderCache.set(folderId, { notes, nextOffset, pages,
        expiresAt: append && cached ? cached.expiresAt : startedAt + cacheTtlMs });
      if (folderCache.size > 128) folderCache.delete(folderCache.keys().next().value!);
      update({ notes, nextOffset });
    } catch (error) {
      if (active && request === listRequest) update({ error: report(error) });
    } finally {
      if (active && request === listRequest) update({ loadingNotes: false, refreshingNotes: false });
    }
  };

  const selectFolder = async (folderId: string, options: { forceRefresh?: boolean } = {}) => {
    if (!active) return;
    ++listRequest;
    ++noteRequest;
    if (options.forceRefresh === true) folderCache.delete(folderId);
    const cached = browse ? folderCache.get(folderId) : undefined;
    if (cached) { folderCache.delete(folderId); folderCache.set(folderId, cached); }
    update({ folderId, notes: cached?.notes ?? [], selectedId: '', note: null, nextOffset: cached?.nextOffset ?? null,
      loadingNote: false, loadingNotes: false, refreshingNotes: false, error: null });
    if (browse && folderId && (!cached || cached.expiresAt <= now())) await loadNotes(folderId, 0, false, !!cached);
  };

  const refresh = async (forceRefresh = true) => {
    active = true;
    const request = ++folderRequest;
    ++listRequest;
    ++noteRequest;
    if (forceRefresh === true) folderCache.clear();
    update({ loadingFolders: true, loadingNotes: false, refreshingNotes: false, loadingNote: false, error: null,
      notes: [], selectedId: '', note: null, nextOffset: null });
    try {
      const folders = await api.folders(forceRefresh);
      if (!active || request !== folderRequest) return;
      const folderIds = new Set(folders.map(folder => folder.id));
      for (const id of folderCache.keys()) if (!folderIds.has(id)) folderCache.delete(id);
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
    applyUpdated: (note: AppleNote) => {
      if (!active) return;
      ++listRequest;
      const summary: AppleNoteSummary = { id: note.id, title: note.title, modifiedAt: note.modifiedAt,
        ...(note.createdAt ? { createdAt: note.createdAt } : {}), locked: note.locked };
      const patchNotes = (notes: AppleNoteSummary[]) => notes.map(item => item.id === note.id ? summary : item);
      for (const [id, cached] of folderCache) folderCache.set(id, { ...cached, notes: patchNotes(cached.notes) });
      update({ notes: patchNotes(state.notes), loadingNotes: false, refreshingNotes: false,
        ...(state.selectedId === note.id ? { note, loadingNote: false } : {}) });
    },
    removeDeleted: (folderId: string, noteId: string) => {
      if (!active) return;
      const cached = folderCache.get(folderId);
      if (cached) {
        const removed = cached.notes.some(note => note.id === noteId);
        folderCache.set(folderId, { ...cached, notes: cached.notes.filter(note => note.id !== noteId),
          nextOffset: removed && cached.nextOffset !== null ? Math.max(0, cached.nextOffset - 1) : cached.nextOffset });
      }
      if (state.folderId !== folderId) return;
      ++folderRequest;
      ++listRequest;
      const removed = state.notes.some(note => note.id === noteId);
      const selected = state.selectedId === noteId;
      if (selected) ++noteRequest;
      update({
        notes: state.notes.filter(note => note.id !== noteId),
        nextOffset: removed && state.nextOffset !== null ? Math.max(0, state.nextOffset - 1) : state.nextOffset,
        loadingFolders: false,
        loadingNotes: false,
        refreshingNotes: false,
        ...(selected ? { selectedId: '', note: null, loadingNote: false, error: null } : {}),
      });
    },
    loadMore: async () => {
      if (state.loadingNotes || state.refreshingNotes || state.loadingFolders || state.nextOffset === null || !active) return;
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
    dispose: () => { active = false; folderCache.clear(); ++folderRequest; ++listRequest; ++noteRequest; },
  };
}
