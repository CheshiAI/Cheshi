import { Pencil, Plus, RefreshCw, Search, StickyNote, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StickyNotesLibraryApi, StickyNoteSummary } from '../../../../shared/sticky-notes';
import { LoadingState, Modal, NeumorphicButton, NeumorphicTextField, SidebarPanelHeader } from '../../shared/ui';
import { InlineRenameField } from '../../shared/ui/InlineRenameField';
import { OverlayScrollArea } from '../../shared/ui/OverlayScrollArea';
import { PullToRefreshStatus } from '../../shared/ui/PullToRefreshStatus';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { usePullToRefresh } from '../../shared/usePullToRefresh';
import sessionStyles from '../chat/ChatSessionList.module.css';
import searchStyles from '../chat/ChatHistorySearch.module.css';
import styles from './StickyNotesList.module.css';

export function StickyNotesList({ api, locked, onNew, onOpen }: {
  api: StickyNotesLibraryApi;
  locked: boolean;
  onNew(): void;
  onOpen(id: string): void | Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<StickyNoteSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<StickyNoteSummary | null>(null);
  const [confirmation, setConfirmation] = useState<StickyNoteSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0), mounted = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const disabled = locked || mutating;
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    try {
      const next = await api.list(query);
      if (!mounted.current || request !== revision.current) return;
      setNotes(next); setLoaded(true); setError(null);
    } catch (error) {
      if (mounted.current && request === revision.current) setError(String(error));
    } finally { if (mounted.current && request === revision.current) setLoading(false); }
  }, [api, query]);
  const pull = usePullToRefresh(refresh, disabled || loading || editing !== null || confirmation !== null);
  useEffect(() => {
    mounted.current = true;
    const update = () => { void refresh(); };
    update();
    const unsubscribe = api.onChanged(update);
    window.addEventListener('focus', update);
    return () => { mounted.current = false; revision.current++; unsubscribe(); window.removeEventListener('focus', update); };
  }, [api, refresh]);

  async function rename(id: string, title: string) {
    setMutating(true);
    try { await api.rename(id, title); await refresh(); }
    finally { if (mounted.current) setMutating(false); }
  }
  async function remove() {
    if (!confirmation || disabled) return;
    setMutating(true); setError(null);
    try {
      const result = await api.deleteSelected([confirmation.id]);
      if (!mounted.current) return;
      if (result.failedIds.length) { setError('The note could not be deleted. Try again.'); return; }
      if (selectedId === confirmation.id) setSelectedId(null);
      setConfirmation(null); await refresh();
    } catch (error) { if (mounted.current) setError(String(error)); }
    finally { if (mounted.current) setMutating(false); }
  }
  const title = (note: StickyNoteSummary) => note.title || 'Untitled note';
  const date = (note: StickyNoteSummary) => <span className={sessionStyles.sessionMetadata}>
    <time dateTime={new Date(note.createdAt).toISOString()} title="Created">
      {new Date(note.createdAt).toLocaleString()}
    </time>
  </span>;
  return <section className={`${sessionStyles.root} ${styles.root}`} aria-label="Saved notes">
    <SidebarPanelHeader title="MEMO" icon={<StickyNote aria-hidden="true" />} actions={<>
      <TooltipButton size="icon" title="Refresh notes" aria-label="Refresh notes"
        className={loaded && (loading || pull.refreshing) ? styles.refreshPending : undefined}
        disabled={disabled || loading || pull.refreshing || editing !== null || confirmation !== null}
        onClick={() => { void pull.refresh(); }}><RefreshCw aria-hidden="true" /></TooltipButton>
      <TooltipButton size="icon" title="New note" aria-label="New note" disabled={disabled} onClick={onNew}><Plus aria-hidden="true" /></TooltipButton>
    </>} />
    <div className={sessionStyles.body}>
      <form className={searchStyles.searchBar} role="search" aria-label="Note search"
        onSubmit={event => { event.preventDefault(); searchInput.current?.focus(); }}>
        <TooltipTarget content="Search note titles and contents"><NeumorphicTextField ref={searchInput}
          className={searchStyles.searchField} variant="standard" type="search" aria-label="Search notes" placeholder="Search…"
          value={query} disabled={disabled} onChange={event => { setEditing(null); setQuery(event.target.value); }}
          onClear={() => { setEditing(null); setQuery(''); }} clearLabel="Clear note search" /></TooltipTarget>
        <TooltipButton raised size="icon" className={searchStyles.searchSubmit} type="submit"
          disabled={disabled || !query.trim()} aria-label="Filter notes" title="Search note titles and contents"><Search aria-hidden="true" /></TooltipButton>
      </form>
      {(error || pull.error) && !confirmation && <p role="alert" className={styles.notice}>{error || pull.error}</p>}
      <OverlayScrollArea className={sessionStyles.listScroll} label="Notes" viewportRef={pull.viewportRef}>
        <PullToRefreshStatus {...pull} />
        <nav className={sessionStyles.list} aria-label="Notes" aria-busy={loading || pull.refreshing}>
          {notes.map(note => <div key={note.id} data-note-id={note.id} data-rename className={sessionStyles.sessionRow}>
            {editing?.id === note.id ? <InlineRenameField initialTitle={note.title} inputLabel="Note title" maxLength={120}
              onSave={value => rename(note.id, value)} onClose={() => setEditing(null)}>{date(note)}</InlineRenameField> : <>
              <NeumorphicButton variant="ghost" className={sessionStyles.session} disabled={disabled}
                aria-label={`Open note: ${title(note)}`} aria-current={selectedId === note.id ? 'page' : undefined}
                onClick={() => { void Promise.resolve().then(() => onOpen(note.id)).then(() => setSelectedId(note.id)).catch(error => setError(String(error))); }}>
                <span className={sessionStyles.sessionTitleRow}><TooltipTarget content={title(note)}>
                  <span className={sessionStyles.sessionTitle}>{title(note)}</span>
                </TooltipTarget></span>
                {date(note)}
              </NeumorphicButton>
              <TooltipButton variant="ghost" size="icon" className={sessionStyles.renameButton} title="Rename note"
                aria-label={`Rename note: ${title(note)}`} disabled={disabled || editing !== null} onClick={() => setEditing(note)}><Pencil aria-hidden="true" /></TooltipButton>
              <TooltipButton variant="ghost" size="icon" className={sessionStyles.deleteButton} title="Delete note"
                aria-label={`Delete note: ${title(note)}`} disabled={disabled || editing !== null}
                onClick={() => { setError(null); setConfirmation(note); }}><Trash2 aria-hidden="true" /></TooltipButton>
            </>}
          </div>)}
          {!loaded && loading && <LoadingState className={sessionStyles.loading} label="Loading notes…" />}
          {loaded && !loading && !notes.length && <p className={styles.notice}>{query.trim() ? 'No matching notes.' : 'No notes yet. Create one with +.'}</p>}
        </nav>
      </OverlayScrollArea>
    </div>
    {confirmation && <Modal title="Delete note?" headerVariant="section" closeButtonVariant="ghost"
      onClose={() => setConfirmation(null)} closeDisabled={disabled}>
      <p>Delete “{title(confirmation)}”?<br />This cannot be undone.</p>
      {error && <p role="alert">{error}</p>}
      <div className={styles.dialogActions}>
        <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => setConfirmation(null)}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" disabled={disabled} onClick={() => { void remove(); }}>Delete</NeumorphicButton>
      </div>
    </Modal>}
  </section>;
}
