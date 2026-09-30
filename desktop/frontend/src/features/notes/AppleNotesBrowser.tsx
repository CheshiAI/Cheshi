import { ChevronRight, LockKeyhole, Paperclip, Plus, RefreshCw, Search, StickyNote, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AppleNote, AppleNotesApi } from '../../../../shared/apple-notes';
import { EmptyState, LiquidGlassPanel, LoadingState, NeumorphicButton, NeumorphicTextField, SidebarPanelHeader } from '../../shared/ui';
import { AppleNotesNewDialog } from './AppleNotesNewDialog';
import { getNewNoteDraft, startNewNoteDraft, releaseNewNoteDraft } from './appleNotesNewDraft';
import { AppleNotesDeleteDialog } from './AppleNotesDeleteDialog';
import { AppleNotesEditor, AppleNotesNewEditor } from './AppleNotesEditor';
import { useAppleNotesBrowser } from './useAppleNotesBrowser';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { OverlayScrollArea } from '../../shared/ui/OverlayScrollArea';
import { usePullToRefresh } from '../../shared/usePullToRefresh';
import { PullToRefreshStatus } from '../../shared/ui/PullToRefreshStatus';
import { MemoFolderContents } from './MemoFolderContents';
import { LOCKED_NOTE_MESSAGE } from './appleNotesModel';
import { LockedNoteState } from './LockedNoteState';
import styles from './AppleNotes.module.css';

export function AppleNotesBrowser({ api, onAttach, attachmentDisabled = false, renderHeader, sidebarTarget, onOpen }: {
  api: AppleNotesApi; onAttach: (note: AppleNote) => Promise<boolean>; attachmentDisabled?: boolean;
  renderHeader?: () => ReactNode;
  sidebarTarget?: HTMLElement | null;
  onOpen?: () => void;
}) {
  const { state, browser } = useAppleNotesBrowser(api);
  const query = state.searchQuery;
  const searching = !!query.trim();
  const [collapsedSearchFolders, setCollapsedSearchFolders] = useState<Set<string>>(new Set());
  const setQuery = (value: string) => {
    setCollapsedSearchFolders(new Set());
    void browser.search(value, { debounce: true });
  };
  const [attaching, setAttaching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [newDraft, setNewDraft] = useState(getNewNoteDraft);
  const navigationDisabled = attaching || editing || !!newDraft;
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ note: AppleNote; folderId: string } | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [expandedFolderId, setExpandedFolderId] = useState<string | null>(null);
  const folderContentId = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const searchResults = new Map(state.searchResults.map(group => [group.folderId, group.notes]));
  const visibleFolders = searching ? state.folders.filter(folder => searchResults.has(folder.id)) : state.folders;
  const isFolderExpanded = (folderId: string) => searching ? !collapsedSearchFolders.has(folderId)
    : folderId === state.folderId && folderId === expandedFolderId;
  const loading = state.loadingFolders || state.loadingNotes || (searching && state.searching);
  const refresh = usePullToRefresh(() => browser.refresh(), loading || navigationDisabled);
  const loadingIndicator = loading ? <LoadingState className={styles.treeLoading}
    label={searching ? 'Searching all notes…' : 'Loading notes…'} /> : null;
  const selectedFolder = state.folders.find(folder => folder.id === state.folderId);
  const editorNote = state.loadingNote ? state.notes.find(note => note.id === state.selectedId) : state.note;
  const lockedNotice = state.error === LOCKED_NOTE_MESSAGE;
  const footerMessage = attachmentError ?? (lockedNotice ? null : state.error);
  const toggleFolder = (folderId: string) => {
    if (navigationDisabled || state.loadingFolders) return;
    if (searching) {
      setCollapsedSearchFolders(current => {
        const next = new Set(current);
        if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
        return next;
      });
      return;
    }
    if (folderId === state.folderId) {
      setExpandedFolderId(current => current === folderId ? null : folderId);
      return;
    }
    setExpandedFolderId(folderId);
    setQuery('');
    setAttachmentError(null);
    setCreated(false);
    setDeleted(false);
    void browser.selectFolder(folderId);
  };
  const attach = async () => {
    if (!state.note || state.loadingNote || attachmentDisabled || navigationDisabled || pending.current) return;
    pending.current = true;
    setAttaching(true);
    setAttachmentError(null);
    try {
      const attached = await onAttach(state.note);
      if (!mounted.current) return;
      if (!attached) setAttachmentError('Could not add this note as text. Check that the conversation is ready and the note is not empty, then try again.');
    } catch (error) {
      if (mounted.current) setAttachmentError(error instanceof Error ? error.message : 'Could not add this note as text.');
    } finally {
      pending.current = false;
      if (mounted.current) setAttaching(false);
    }
  };

  const search = <div className={styles.sidebarSearch} role="search" aria-label="Memo search">
    <NeumorphicTextField variant="standard" className={styles.searchField} type="search"
      aria-label="Search all notes" placeholder="Search…" value={query}
      onChange={event => setQuery(event.target.value)} disabled={navigationDisabled}
      onClear={() => setQuery('')} clearLabel="Clear note search" />
    <Search className={styles.searchIcon} aria-hidden="true" />
  </div>;

  const noteActions = <>
    <NeumorphicButton variant="ghost" size="icon" aria-label="Delete note" title="Delete note"
      disabled={!state.note || state.loadingNote || navigationDisabled} onClick={() => {
        if (!state.note || state.loadingNote || navigationDisabled || pending.current) return;
        setCreated(false);
        setDeleted(false);
        setDeleteTarget({ note: state.note, folderId: state.folderId });
      }}><Trash2 aria-hidden="true" /></NeumorphicButton>
    <TooltipButton variant="ghost" size="icon" aria-label="Attach to conversation"
      title={attaching ? 'Adding…' : 'Add to conversation as text · Appends the saved note to your message.'}
      aria-busy={attaching} disabled={!state.note || state.loadingNote || navigationDisabled || attachmentDisabled}
      onClick={() => void attach()}><Paperclip aria-hidden="true" /></TooltipButton>
  </>;

  const sidebar = <LiquidGlassPanel as="aside" className={styles.folderPanel} aria-label="Memo folders">
          <SidebarPanelHeader title="MEMO" icon={<StickyNote aria-hidden="true" />} actions={<>
            <TooltipButton size="icon" aria-label="Refresh Apple Notes" title="Refresh Apple Notes"
              disabled={loading || navigationDisabled || refresh.refreshing}
              onClick={() => { if (!loading && !navigationDisabled) void refresh.refresh(); }}><RefreshCw aria-hidden="true" /></TooltipButton>
            <TooltipButton size="icon" aria-label="New memo" title="New memo" disabled={navigationDisabled}
              onClick={() => { if (!navigationDisabled) { onOpen?.(); setCreated(false); setDeleted(false); setCreating(true); } }}><Plus aria-hidden="true" /></TooltipButton>
          </>} />
          <div className={styles.sidebarBody}>
          {search}
          <OverlayScrollArea className={styles.folderScroll} label="Memo folder list" viewportRef={refresh.viewportRef}>
          <PullToRefreshStatus {...refresh} />
          {!refresh.refreshing && refresh.pullHeight === 0 && loadingIndicator}
          <nav className={styles.folderTree} aria-label="Folders and notes">
            <ul className={styles.folderList}>
              {visibleFolders.map(folder => {
                const expanded = isFolderExpanded(folder.id);
                const notes = searching ? searchResults.get(folder.id) ?? [] : state.notes;
                const contentId = `${folderContentId}-${encodeURIComponent(folder.id)}`;
                return <li key={folder.id} className={styles.folderSection}>
                  <TooltipTarget content={`${folder.account} / ${folder.path}`}><button type="button" className={styles.folderRow} aria-expanded={expanded}
                    aria-controls={expanded ? contentId : undefined} aria-label={`${folder.account} / ${folder.path}`}
                    disabled={state.loadingFolders || navigationDisabled}
                    onClick={() => toggleFolder(folder.id)}>
                    <span className={styles.folderLabel}><span>{folder.path}</span><small>{folder.account}</small></span>
                    <span className={styles.folderToggle} aria-hidden="true"><ChevronRight className={styles.folderChevron} /></span>
                  </button></TooltipTarget>
                  <MemoFolderContents expanded={expanded}>
                  {expanded && <div id={contentId} className={styles.folderNotes} role="region" aria-label="Notes">
                    {notes.map(note => <TooltipTarget key={note.id} content={note.locked ? `${note.title || 'Untitled note'} · Password protected` : note.title}><button type="button" className={styles.noteRow}
                      data-locked={note.locked} aria-pressed={!newDraft && state.selectedId === note.id} disabled={navigationDisabled}
                      onClick={() => { if (!navigationDisabled) {
                        onOpen?.();
                        if (searching) setExpandedFolderId(folder.id);
                        void browser.selectNote(note.id, searching ? folder.id : undefined);
                      } }}>
                      {note.locked && <LockKeyhole className={styles.noteLock} aria-hidden="true" />}
                      <span>{note.title || 'Untitled note'}</span>
                    </button></TooltipTarget>)}
                    {!searching && !state.loadingFolders && !state.loadingNotes && notes.length === 0 && <p className={styles.treeMessage}>
                      This folder has no notes.
                    </p>}
                    {!searching && state.nextOffset !== null && <button type="button" className={styles.loadMore} disabled={state.loadingNotes || state.refreshingNotes || navigationDisabled}
                      onClick={() => void browser.loadMore()}>Load more notes</button>}
                  </div>}
                  </MemoFolderContents>
                </li>;
              })}
            </ul>
            {searching && state.searchError && <p className={styles.treeMessage} role="alert">{state.searchError}</p>}
            {searching && !loading && !state.searchError && state.folders.length > 0 && visibleFolders.length === 0
              && <p className={styles.treeMessage} role="status">No matching notes.</p>}
            {!state.loadingFolders && state.folders.length === 0 && <p className={styles.treeMessage}>Open Notes and add an account to get started.</p>}
            {state.error && !lockedNotice && <p className={styles.treeMessage} role="alert">{state.error}</p>}
          </nav>
          </OverlayScrollArea>
          </div>
        </LiquidGlassPanel>;

  return <>
    {renderHeader?.()}
    {sidebarTarget ? createPortal(sidebar, sidebarTarget) : sidebarTarget === undefined ? sidebar : null}
    <div className={styles.workspaceContent}>
      {deleteTarget && <AppleNotesDeleteDialog api={api} note={deleteTarget.note} onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          setDeleted(true);
          setAttachmentError(null);
          browser.removeDeleted(deleteTarget.folderId, deleteTarget.note.id);
        }} />}
      {creating && <AppleNotesNewDialog api={api} initialFolderId={state.folderId}
        onClose={() => setCreating(false)} onContinue={folder => {
          setCreating(false);
          setQuery('');
          setExpandedFolderId(folder.id);
          setAttachmentError(null);
          setNewDraft(startNewNoteDraft(folder));
          void browser.selectFolder(folder.id);
        }} />}

      <div className={styles.browser} aria-busy={state.loadingFolders || state.loadingNotes}>
        <div className={styles.documentPane}>
          {newDraft ? <AppleNotesNewEditor api={api} draft={newDraft} onBusyChange={setEditing}
            onDiscard={() => { releaseNewNoteDraft(newDraft); setNewDraft(null); setEditing(false); }}
            onSaved={note => {
              browser.applyCreated(newDraft.folder.id, note);
              releaseNewNoteDraft(newDraft);
              setNewDraft(null);
              setEditing(false);
              setCreated(true);
            }} /> : editorNote ? <AppleNotesEditor key={editorNote.id} api={api} note={editorNote} loadingNote={state.loadingNote}
            disabled={attaching} onSaved={browser.applyUpdated} onBusyChange={setEditing}>{noteActions}</AppleNotesEditor> : <>
            <div className={styles.emptyEditorHeader}><span>{selectedFolder?.path ?? 'Memo'}</span><div className={styles.headerActions}>{noteActions}</div></div>
            <section className={styles.documentScroll} aria-label="Note preview">
              {lockedNotice && state.selectedId
                ? <LockedNoteState key={state.selectedId} api={api} noteId={state.selectedId} />
                : <EmptyState className={styles.emptyDocument} title="Memo" description="Select a note to read its text." />}
            </section>
          </>}
          {(created || deleted || footerMessage) && <footer className={styles.documentFooter}>
            {created && <p role="status">Saved to Apple Notes.</p>}
            {deleted && <p role="status">Deleted from Apple Notes.</p>}
            {footerMessage && <p className={styles.error} role="alert">{footerMessage}</p>}
          </footer>}
        </div>
      </div>
    </div>
  </>;
}
