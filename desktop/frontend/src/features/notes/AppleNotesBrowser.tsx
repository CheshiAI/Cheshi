import { ChevronRight, Folder, FolderOpen, LockKeyhole, Paperclip, Plus, RefreshCw, Search, StickyNote, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AppleNote, AppleNotesApi } from '../../../../shared/apple-notes';
import { EmptyState, LiquidGlassPanel, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import { AppleNotesNewDialog } from './AppleNotesNewDialog';
import { getNewNoteDraft, startNewNoteDraft, releaseNewNoteDraft } from './appleNotesNewDraft';
import { AppleNotesDeleteDialog } from './AppleNotesDeleteDialog';
import { AppleNotesEditor, AppleNotesNewEditor } from './AppleNotesEditor';
import { useAppleNotesBrowser } from './useAppleNotesBrowser';
import styles from './AppleNotes.module.css';

export function AppleNotesBrowser({ api, onAttach, attachmentDisabled = false, renderHeader }: {
  api: AppleNotesApi; onAttach: (note: AppleNote) => Promise<boolean>; attachmentDisabled?: boolean;
  renderHeader?: (refresh: ReactNode, create: ReactNode, search: ReactNode) => ReactNode;
}) {
  const { state, browser } = useAppleNotesBrowser(api);
  const [query, setQuery] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [newDraft, setNewDraft] = useState(getNewNoteDraft);
  const navigationDisabled = attaching || editing || !!newDraft;
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ note: AppleNote; folderId: string } | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [collapsedFolderId, setCollapsedFolderId] = useState<string | null>(null);
  const folderContentId = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const notes = state.notes.filter(note => note.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedFolder = state.folders.find(folder => folder.id === state.folderId);
  const editorNote = state.loadingNote ? state.notes.find(note => note.id === state.selectedId) : state.note;
  const toggleFolder = (folderId: string) => {
    if (navigationDisabled || state.loadingFolders) return;
    if (folderId === state.folderId) {
      setCollapsedFolderId(current => current === folderId ? null : folderId);
      return;
    }
    setCollapsedFolderId(null);
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
      if (!attached) setAttachmentError('Could not attach this note. Check the conversation attachment limit and try again.');
    } catch (error) {
      if (mounted.current) setAttachmentError(error instanceof Error ? error.message : 'Could not attach this note.');
    } finally {
      pending.current = false;
      if (mounted.current) setAttaching(false);
    }
  };

  const search = <span className={styles.headerSearch}>
      <NeumorphicTextField type="search" aria-label="Search loaded notes" placeholder="Search loaded notes by title" value={query}
        onChange={event => setQuery(event.target.value)} disabled={navigationDisabled}
        trailingAction={query ? <SearchClearButton aria-label="Clear note search" onClick={() => setQuery('')} /> : undefined} />
      <Search className={styles.searchIcon} aria-hidden="true" data-disabled={attaching ? 'true' : undefined} />
    </span>;

  const noteActions = <>
    <NeumorphicButton raised size="icon" aria-label="Delete note" title="Delete note"
      disabled={!state.note || state.loadingNote || navigationDisabled} onClick={() => {
        if (!state.note || state.loadingNote || navigationDisabled || pending.current) return;
        setCreated(false);
        setDeleted(false);
        setDeleteTarget({ note: state.note, folderId: state.folderId });
      }}><Trash2 aria-hidden="true" /></NeumorphicButton>
    <NeumorphicButton raised size="icon" aria-label="Attach to conversation" title={attaching ? 'Attaching…' : 'Attach to conversation'}
      aria-busy={attaching} disabled={!state.note || state.loadingNote || navigationDisabled || attachmentDisabled}
      onClick={() => void attach()}><Paperclip aria-hidden="true" /></NeumorphicButton>
  </>;

  return <>
    {renderHeader?.(
      <NeumorphicButton raised size="icon" aria-label="Refresh Apple Notes" title="Refresh Apple Notes"
        disabled={state.loadingFolders || navigationDisabled} onClick={() => { if (!navigationDisabled) void browser.refresh(); }}><RefreshCw aria-hidden="true" /></NeumorphicButton>,
      <NeumorphicButton raised size="icon" aria-label="새 메모" title="새 메모" disabled={navigationDisabled}
        onClick={() => { if (!navigationDisabled) { setCreated(false); setDeleted(false); setCreating(true); } }}><Plus aria-hidden="true" /></NeumorphicButton>,
      search,
    )}
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
          setCollapsedFolderId(null);
          setAttachmentError(null);
          setNewDraft(startNewNoteDraft(folder));
          void browser.selectFolder(folder.id);
        }} />}

      {!renderHeader && search}
      <div className={styles.browser} aria-busy={state.loadingFolders || state.loadingNotes}>
        <LiquidGlassPanel as="aside" className={styles.folderPanel} aria-label="Memo folders">
          <h2 className={styles.folderHeading}>FOLDERS</h2>
          <nav className={styles.folderTree} aria-label="Folders and notes">
            <ul className={styles.folderList}>
              {state.folders.map(folder => {
                const expanded = folder.id === state.folderId && folder.id !== collapsedFolderId;
                return <li key={folder.id}>
                  <button type="button" className={styles.folderRow} aria-expanded={expanded}
                    aria-controls={expanded ? folderContentId : undefined} aria-label={`${folder.account} / ${folder.path}`}
                    title={`${folder.account} / ${folder.path}`} disabled={state.loadingFolders || navigationDisabled}
                    onClick={() => toggleFolder(folder.id)}>
                    <ChevronRight className={styles.folderChevron} aria-hidden="true" />
                    {expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
                    <span className={styles.folderLabel}><span>{folder.path}</span><small>{folder.account}</small></span>
                  </button>
                  {expanded && <div id={folderContentId} className={styles.folderNotes} role="region" aria-label="Notes">
                    {notes.map(note => <button type="button" key={note.id} className={styles.noteRow}
                      aria-pressed={!newDraft && state.selectedId === note.id} disabled={navigationDisabled} title={note.title}
                      onClick={() => { if (!navigationDisabled) void browser.selectNote(note.id); }}>
                      {note.locked ? <LockKeyhole aria-hidden="true" /> : <StickyNote aria-hidden="true" />}
                      <span>{note.title || 'Untitled note'}{note.locked && <small>Password protected</small>}</span>
                    </button>)}
                    {!state.loadingFolders && !state.loadingNotes && notes.length === 0 && <p className={styles.treeMessage}>
                      {query ? 'No matching loaded notes.' : 'This folder has no notes.'}
                    </p>}
                    {state.nextOffset !== null && <button type="button" className={styles.loadMore} disabled={state.loadingNotes || state.refreshingNotes || navigationDisabled}
                      onClick={() => void browser.loadMore()}>Load more notes</button>}
                    {state.loadingNotes && <p className={styles.treeMessage} role="status">Loading notes…</p>}
                  </div>}
                </li>;
              })}
            </ul>
            {state.loadingFolders && <p className={styles.treeMessage} role="status">Loading folders…</p>}
            {!state.loadingFolders && state.folders.length === 0 && <p className={styles.treeMessage}>Open Notes and add an account to get started.</p>}
          </nav>
        </LiquidGlassPanel>
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
              <EmptyState className={styles.emptyDocument} title="Memo" description="Select a note to read its text." />
            </section>
          </>}
          <footer className={styles.documentFooter}>
            {created && <p role="status">Saved to Apple Notes.</p>}
            {deleted && <p role="status">Deleted from Apple Notes.</p>}
            {(state.error || attachmentError) && <p className={styles.error} role="alert">{attachmentError ?? state.error}</p>}
            <p className={styles.hint}>Only the saved note’s text is attached to the conversation.</p>
          </footer>
        </div>
      </div>
    </div>
  </>;
}
