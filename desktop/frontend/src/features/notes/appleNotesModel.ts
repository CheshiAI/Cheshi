import type { AppleNote, AppleNoteSummary, AppleNotesApi, AppleNotesFolder } from '../../../../shared/apple-notes';

export const LOCKED_NOTE_MESSAGE = 'This note is password protected. Choose an unlocked note.';

export function appleNoteDraftText(note: AppleNote): string {
  if (note.locked !== false) throw new Error('Password-protected notes cannot be added to a conversation.');
  return note.plaintext;
}

function summarizeNote(note: AppleNote): AppleNoteSummary {
  return { id: note.id, title: note.title, modifiedAt: note.modifiedAt,
    ...(note.createdAt ? { createdAt: note.createdAt } : {}), locked: note.locked };
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
  searchQuery: string;
  searchResults: { folderId: string; notes: (AppleNoteSummary & { snippet?: string })[] }[];
  searchStatus?: string;
  searchNextOffset?: number | null;
  searchTotal?: number;
  searching: boolean;
  searchError: string | null;
}

interface FolderNotesCache {
  notes: AppleNoteSummary[];
  nextOffset: number | null;
  pages: number;
  expiresAt: number;
}

// Each request is scoped to the folder/note that started it. Late responses may
// not replace a different preview or revive a dialog after it has closed.
export function createAppleNotesBrowser(api: AppleNotesApi, browse: boolean, now: () => number = Date.now) {
  let state: AppleNotesBrowserState = { folders: [], folderId: '', notes: [], selectedId: '', note: null,
    nextOffset: null, loadingFolders: false, loadingNotes: false, refreshingNotes: false, loadingNote: false, error: null,
    searchQuery: '', searchResults: [], searching: false, searchError: null };
  const folderCache = new Map<string, FolderNotesCache>();
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchVersion = '';
  const cancelSearchTimer = () => { if (searchTimer) clearTimeout(searchTimer); searchTimer = null; };
  const cacheTtlMs = 30_000;
  const listeners = new Set<() => void>();
  let active = true;
  let folderRequest = 0;
  let listRequest = 0;
  let noteRequest = 0;
  let searchRequest = 0;
  const update = (patch: Partial<AppleNotesBrowserState>) => {
    if (!active) return;
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const report = (error: unknown) => error instanceof Error ? error.message : 'Apple Notes is unavailable.';
  const cacheFolder = (id: string, entry: FolderNotesCache) => {
    folderCache.delete(id);
    folderCache.set(id, entry);
    if (folderCache.size > 128) folderCache.delete(folderCache.keys().next().value!);
  };
  const search = async (query: string, options: { debounce?: boolean; refresh?: boolean; more?: boolean } = {}) => {
    if (!active) return;
    const request = ++searchRequest;
    cancelSearchTimer();
    const more = options.more === true;
    const offset = more ? state.searchNextOffset : 0;
    if (more && offset == null) return;
    update({ searchQuery: query, ...(more ? {} : { searchResults: [], searchNextOffset: null }),
      searching: !!query.trim(), searchError: null });
    if (options.debounce === true && query.trim()) {
      await new Promise<void>(resolve => setTimeout(resolve, 250));
      if (!active || request !== searchRequest) return;
    }
    if (!api.search) {
      update({ searching: false, searchStatus: '', searchError: query.trim() ? 'Note search is unavailable. Restart Cheshi.' : null });
      return;
    }
    const load = async (first: boolean) => {
      try {
        let result = await api.search!({ query, offset: first && more ? offset! : 0,
          ...(first && more ? { version: searchVersion } : {}), refresh: first && options.refresh === true });
        if (!active || request !== searchRequest) return;
        // Keep already expanded pages when background indexing refreshes the results.
        const retainedCount = state.searchResults.reduce((count, group) => count + group.notes.length, 0);
        while (!first && result.nextOffset !== null && result.hits.length < retainedCount) {
          const page = await api.search!({ query, offset: result.nextOffset, version: result.version });
          if (!active || request !== searchRequest) return;
          result = { ...page, hits: [...result.hits, ...page.hits] };
        }
        searchVersion = result.version;
        const groups = new Map((first && more ? state.searchResults : []).map(group => [group.folderId, group.notes]));
        for (const hit of result.hits) {
          const notes = groups.get(hit.folderId) ?? [];
          groups.set(hit.folderId, [...notes.filter(note => note.id !== hit.id), hit]);
        }
        const updating = result.state === 'building' || result.state === 'updating';
        update({ searchResults: [...groups].map(([folderId, notes]) => ({ folderId, notes })),
          ...(result.folders.length ? { folders: result.folders } : {}),
          searching: !!query.trim() && updating, searchNextOffset: result.nextOffset, searchTotal: result.total,
          searchStatus: updating ? `${result.state === 'building' ? 'Preparing note search' : 'Updating note search'}… ${result.completed}/${result.pending}` : '',
          searchError: result.error });
        if (updating || query.trim()) {
          searchTimer = setTimeout(() => { searchTimer = null; if (active && request === searchRequest) void load(false); }, updating ? 500 : 30_000);
        }
      } catch (error) {
        if (active && request === searchRequest) update({ searching: false, searchStatus: '', searchError: report(error) });
      }
    };
    await load(true);
  };
  const restartSearch = () => { if (state.searchQuery.trim()) void search(state.searchQuery); };

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
      cacheFolder(folderId, { notes, nextOffset, pages,
        expiresAt: append && cached ? cached.expiresAt : startedAt + cacheTtlMs });
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
    ++searchRequest;
    cancelSearchTimer();
    ++listRequest;
    ++noteRequest;
    if (forceRefresh === true) folderCache.clear();
    update({ loadingFolders: true, loadingNotes: false, refreshingNotes: false, loadingNote: false, error: null,
      notes: [], selectedId: '', note: null, nextOffset: null,
      searchResults: [], searching: !!state.searchQuery.trim(), searchError: null });
    try {
      const folders = await api.folders(forceRefresh);
      if (!active || request !== folderRequest) return;
      const folderIds = new Set(folders.map(folder => folder.id));
      for (const id of folderCache.keys()) if (!folderIds.has(id)) folderCache.delete(id);
      const selected = folders.find(folder => folder.id === state.folderId)
        ?? folders.find(folder => folder.isDefault) ?? folders[0];
      update({ folders, loadingFolders: false });
      await selectFolder(selected?.id ?? '');
      if (active && request === folderRequest) await search(state.searchQuery, { refresh: forceRefresh });
    } catch (error) {
      if (active && request === folderRequest) update({ error: report(error), folders: [], folderId: '', searching: false });
    } finally {
      if (active && request === folderRequest) update({ loadingFolders: false });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    search,
    loadMoreSearch: () => search(state.searchQuery, { more: true }),
    selectFolder,
    applyCreated: (folderId: string, note: AppleNote) => {
      if (!active) return;
      const request = ++folderRequest;
      const needsFolders = state.loadingFolders || state.folders.length === 0;
      ++listRequest;
      ++noteRequest;
      const cached = folderCache.get(folderId);
      // Invalidate pagination after insertion; a later folder visit reloads it.
      folderCache.delete(folderId);
      const previousNotes = cached?.notes ?? (state.folderId === folderId ? state.notes : []);
      const inserted = !previousNotes.some(item => item.id === note.id);
      const notes = [summarizeNote(note), ...previousNotes.filter(item => item.id !== note.id)];
      const nextOffset = cached?.nextOffset ?? (state.folderId === folderId ? state.nextOffset : null);
      update({ folderId, notes, nextOffset: nextOffset === null ? null : nextOffset + (inserted ? 1 : 0),
        selectedId: note.id, note, loadingFolders: needsFolders, loadingNotes: false, refreshingNotes: false, loadingNote: false, error: null });
      restartSearch();
      // A save may complete while Memo is remounting. Finish metadata loading
      // without letting the initial refresh clear the newly selected document.
      if (needsFolders) void api.folders().then(folders => {
        if (active && request === folderRequest) update({ folders, loadingFolders: false });
      }).catch(error => {
        if (active && request === folderRequest) update({ error: report(error), loadingFolders: false });
      });
    },
    applyUpdated: (note: AppleNote) => {
      if (!active) return;
      ++listRequest;
      const summary = summarizeNote(note);
      const patchNotes = (notes: AppleNoteSummary[]) => notes.map(item => item.id === note.id ? summary : item);
      for (const [id, cached] of folderCache) folderCache.set(id, { ...cached, notes: patchNotes(cached.notes) });
      update({ notes: patchNotes(state.notes), loadingNotes: false, refreshingNotes: false,
        ...(state.selectedId === note.id ? { note, loadingNote: false } : {}) });
      restartSearch();
    },
    removeDeleted: (folderId: string, noteId: string) => {
      if (!active) return;
      const cached = folderCache.get(folderId);
      if (cached) {
        const removed = cached.notes.some(note => note.id === noteId);
        folderCache.set(folderId, { ...cached, notes: cached.notes.filter(note => note.id !== noteId),
          nextOffset: removed && cached.nextOffset !== null ? Math.max(0, cached.nextOffset - 1) : cached.nextOffset });
      }
      if (state.folderId !== folderId) { restartSearch(); return; }
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
      restartSearch();
    },
    loadMore: async () => {
      if (state.loadingNotes || state.refreshingNotes || state.loadingFolders || state.nextOffset === null || !active) return;
      await loadNotes(state.folderId, state.nextOffset, true);
    },
    selectNote: async (id: string, folderId?: string) => {
      if (!active) return;
      if (folderId !== undefined) {
        const result = state.searchResults.find(group => group.folderId === folderId)?.notes.find(note => note.id === id);
        if (!result) return;
        const selection = selectFolder(folderId);
        const selectionRequest = noteRequest;
        await selection;
        if (!active || selectionRequest !== noteRequest) return;
        if (!state.notes.some(note => note.id === id)) update({ notes: [...state.notes, result] });
      }
      const request = ++noteRequest;
      const selected = state.notes.find(note => note.id === id);
      update({ selectedId: id, note: null, loadingNote: false, error: null });
      if (!selected || !active) return;
      if (selected.locked) { update({ error: LOCKED_NOTE_MESSAGE }); return; }
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
    dispose: () => { active = false; folderCache.clear(); cancelSearchTimer(); ++searchRequest; ++folderRequest; ++listRequest; ++noteRequest; },
  };
}
