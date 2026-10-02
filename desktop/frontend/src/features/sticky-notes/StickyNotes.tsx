import { List, Pin, PinOff, Plus, StickyNote as NoteIcon, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { hasStickyNoteContent, STICKY_NOTE_TEXT_LIMIT, type StickyNote, type StickyNotesApi } from '../../../../shared/sticky-notes';
import { Modal, NeumorphicButton } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { ToolbarMenu } from '../../shared/ui/ToolbarMenu';
import { SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import { applyWindowAppearance } from '../settings/windowAppearance';
import { StickyNoteDraft, type StickyNoteSaveState } from './stickyNoteDraft';
import styles from './StickyNotes.module.css';
import { StickyNotesList } from './StickyNotesList';

declare global { interface Window { cheshiStickyNotes?: StickyNotesApi } }

export function StickyNotes({ api }: { api: StickyNotesApi }) {
  const [note, setNote] = useState<StickyNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<StickyNoteSaveState>({ saving: false, pending: false, error: null });
  const [locked, setLocked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [shortcutAvailable, setShortcutAvailable] = useState(true);
  const [listShortcutAvailable, setListShortcutAvailable] = useState(true);
  const draft = useRef<StickyNoteDraft | null>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);

  const fail = (error: unknown) => setError(error instanceof Error ? error.message : 'Could not complete this action.');
  async function close() {
    setLocked(true);
    try { await draft.current?.flush(); await api.close(); }
    catch (error) { fail(error); }
    finally { setLocked(false); }
  }
  useEffect(() => {
    let active = true;
    let appearanceRevision = 0;
    const removeAppearance = api.onAppearance(state => { appearanceRevision++; applyWindowAppearance(state); });
    void api.appearance().then(state => { if (active && appearanceRevision === 0) applyWindowAppearance(state); }).catch(fail);
    const initialize = api.read().then(value => {
      if (!active) return;
      setNote(value.note); setListing(!value.note); setShortcutAvailable(value.shortcutAvailable);
      setListShortcutAvailable(value.listShortcutAvailable);
      draft.current = value.note ? new StickyNoteDraft(value.note, content => api.save(content), state => {
        if (active) setSaveState(state);
      }) : null;
      setLoading(false);
    });
    void initialize.catch(fail);
    const removeRequest = api.onRequest(request => {
      if (request.kind === 'resume') { setLocked(false); return; }
      void (async () => {
        await initialize;
        if (request.kind === 'close') { await close(); return; }
        setLocked(true);
        try { await draft.current?.flush(); await api.acknowledge(request.token); }
        catch (error) {
          fail(error);
          await api.acknowledge(request.token, error instanceof Error ? error.message : 'Could not save this note.');
        }
      })().catch(fail);
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draft.current?.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { active = false; draft.current?.dispose(); removeRequest(); removeAppearance(); window.removeEventListener('beforeunload', beforeUnload); };
  }, [api]);

  useEffect(() => { if (!listing) textArea.current?.focus(); }, [listing, loading]);

  async function toggleList() {
    setLocked(true);
    try { await draft.current?.flush(); setListing(value => note ? !value : true); }
    catch (error) { fail(error); }
    finally { setLocked(false); }
  }

  function edit(patch: Partial<Pick<StickyNote, 'title' | 'text'>>) {
    if (!note || locked) return;
    const next = { ...note, ...patch };
    setNote(next);
    draft.current?.update({ title: next.title, text: next.text });
  }
  async function pin() {
    if (!note) return;
    setLocked(true);
    try { await api.pin(!note.pinned); setNote({ ...note, pinned: !note.pinned }); }
    catch (error) { fail(error); }
    finally { setLocked(false); }
  }
  const newNote = () => { void api.create().catch(fail); };
  return <main className={`window-appearance-surface ${styles.root}`} aria-label="Sticky notes">
    <header className={styles.header}>
      <div className={styles.heading}>
        <SidebarPanelTitle as="h2" title={listing ? 'NOTES' : 'QUICK NOTE'} icon={<NoteIcon aria-hidden="true" />} />
      </div>
      <div className={styles.actions}>
        <TooltipButton size="icon" variant="ghost" title="New note" aria-label="New note" disabled={locked || loading} onClick={newNote}><Plus aria-hidden="true" /></TooltipButton>
        {note && <TooltipButton size="icon" variant="ghost" title={note.pinned ? 'Unpin note' : 'Keep on top'}
          aria-label={note.pinned ? 'Unpin note' : 'Keep on top'} aria-pressed={note.pinned} active={note.pinned}
          disabled={locked} onClick={() => { void pin(); }}>{note.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}</TooltipButton>}
        <ToolbarMenu label="Note actions" items={[
          { id: 'list', label: listing && note ? 'Back to note' : 'All notes', icon: <List aria-hidden="true" />, disabled: locked,
            onSelect: () => { void toggleList(); } },
          ...(note && !listing ? [{ id: 'delete', label: 'Delete note', icon: <Trash2 aria-hidden="true" />, separatorBefore: true,
            disabled: locked, onSelect: () => setDeleting(true) }] : []),
        ]} />
        <TooltipButton size="icon" variant="ghost" title="Close window" aria-label="Close window" disabled={locked}
          onClick={() => { void close(); }}><X aria-hidden="true" /></TooltipButton>
      </div>
    </header>
    {!shortcutAvailable && <p className={styles.notice}>Shortcut unavailable. Use Notes → New Note in the app menu.</p>}
    {!listShortcutAvailable && <p className={styles.notice}>List shortcut unavailable. Use Notes → All Notes in the app menu.</p>}
    {(error || saveState.error) && <div role="alert" className={styles.notice}>
      {error || saveState.error}
      <NeumorphicButton variant="ghost" onClick={() => { setError(null); void draft.current?.flush().catch(fail); }}>Retry save</NeumorphicButton>
    </div>}
    {loading ? <p className={styles.notice}>Opening notes…</p> : listing ? <StickyNotesList api={api} locked={locked} onOpen={id => {
      if (id === note?.id) setListing(false);
      else void api.open(id).catch(fail);
    }} onDeleted={ids => {
      if (note && ids.includes(note.id)) {
        draft.current?.dispose(); draft.current = null; setNote(null);
        setSaveState({ saving: false, pending: false, error: null });
      }
    }} /> : note && <div className={styles.editor}>
      <input aria-label="Note title" placeholder="Untitled note" maxLength={120} value={note.title} readOnly={locked}
        className={styles.title} onChange={event => edit({ title: event.target.value })} />
      <textarea ref={textArea} aria-label="Note text" placeholder="Write something…" maxLength={STICKY_NOTE_TEXT_LIMIT}
        value={note.text} readOnly={locked} onChange={event => edit({ text: event.target.value })} />
      <span role="status" className={styles.status}>{saveState.error ? 'Not saved' : saveState.saving ? 'Saving…'
        : saveState.pending ? 'Unsaved changes' : hasStickyNoteContent(note) ? 'Saved' : 'Write something to save this note'}</span>
    </div>}
    {deleting && <Modal title="Delete note?" headerVariant="section" closeButtonVariant="ghost" onClose={() => setDeleting(false)} closeDisabled={locked}>
      <p>This note will be permanently deleted.</p>
      <div className={styles.dialogActions}>
        <NeumorphicButton variant="ghost" disabled={locked} onClick={() => setDeleting(false)}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" disabled={locked} onClick={() => {
          setLocked(true);
          void (async () => { await draft.current?.flush(); await api.delete(); })().catch(error => { fail(error); setLocked(false); });
        }}>Delete</NeumorphicButton>
      </div>
    </Modal>}
  </main>;
}
