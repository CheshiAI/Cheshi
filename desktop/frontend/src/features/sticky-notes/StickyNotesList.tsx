import { useCallback, useEffect, useRef, useState } from 'react';
import type { StickyNotesApi, StickyNoteSummary } from '../../../../shared/sticky-notes';
import { Modal, NeumorphicButton, NeumorphicCheckbox } from '../../shared/ui';
import styles from './StickyNotes.module.css';

export function StickyNotesList({ api, locked, onOpen, onDeleted }: {
  api: StickyNotesApi;
  locked: boolean;
  onOpen(id: string): void;
  onDeleted(ids: string[]): void;
}) {
  const [notes, setNotes] = useState<StickyNoteSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<StickyNoteSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const selectedNotes = notes.filter(note => selected.has(note.id));
  const disabled = locked || deleting;
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    try {
      const next = await api.list();
      if (!mounted.current || request !== revision.current) return;
      setNotes(next);
      setSelected(current => new Set([...current].filter(id => next.some(note => note.id === id))));
    } catch (error) {
      if (mounted.current && request === revision.current) setError(String(error));
    } finally { if (mounted.current && request === revision.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    const update = () => { void refresh(); };
    update();
    const unsubscribe = api.onChanged(update);
    window.addEventListener('focus', update);
    return () => { mounted.current = false; revision.current++; unsubscribe(); window.removeEventListener('focus', update); };
  }, [api, refresh]);

  async function remove() {
    if (!confirmation || disabled) return;
    setDeleting(true); setError(null); revision.current++;
    try {
      const result = await api.deleteSelected(confirmation.map(note => note.id));
      if (!mounted.current) return;
      onDeleted(result.deletedIds);
      setSelected(new Set(result.failedIds));
      setConfirmation(null);
      if (result.failedIds.length) setError(`${result.failedIds.length} note(s) could not be deleted. They remain selected for retry.`);
      await refresh();
    } catch (error) { if (mounted.current) setError(String(error)); }
    finally { if (mounted.current) setDeleting(false); }
  }

  return <section className={styles.list} aria-label="Saved notes" aria-busy={loading}>
    <div className={styles.listActions}>
      <NeumorphicCheckbox aria-label="Select all notes" disabled={disabled || loading || notes.length === 0}
        checked={notes.length > 0 && selectedNotes.length === notes.length}
        indeterminate={selectedNotes.length > 0 && selectedNotes.length < notes.length}
        onChange={event => setSelected(new Set(event.target.checked ? notes.map(note => note.id) : []))} />
      <span>{selectedNotes.length} selected</span>
      <NeumorphicButton variant="ghost" disabled={disabled || loading || !selectedNotes.length}
        onClick={() => setConfirmation(selectedNotes)}>Delete selected</NeumorphicButton>
    </div>
    {error && <p role="alert">{error}</p>}
    {!loading && notes.length === 0 && <p>No notes yet. Create one with +.</p>}
    {notes.map(note => <div key={note.id} className={styles.listRow} data-note-id={note.id}>
      <NeumorphicCheckbox aria-label={`Select ${note.title || 'Untitled note'}`} disabled={disabled}
        checked={selected.has(note.id)} onChange={event => {
          const checked = event.target.checked;
          setSelected(current => { const next = new Set(current); if (checked) next.add(note.id); else next.delete(note.id); return next; });
        }} />
      <NeumorphicButton variant="ghost" className={styles.item} disabled={disabled} onClick={() => onOpen(note.id)}>
        <strong>{note.title || 'Untitled note'}</strong><span>{note.preview || 'Empty note'}</span>
        <small>{new Date(note.updatedAt).toLocaleString()}</small>
      </NeumorphicButton>
    </div>)}
    {confirmation && <Modal title={`Delete ${confirmation.length} note(s)?`} headerVariant="section" closeButtonVariant="ghost"
      onClose={() => setConfirmation(null)} closeDisabled={disabled}>
      <p>Only the selected notes will be permanently deleted.</p>
      <ul>{confirmation.slice(0, 5).map(note => <li key={note.id}>{note.title || 'Untitled note'}</li>)}</ul>
      {confirmation.length > 5 && <p>And {confirmation.length - 5} more.</p>}
      <div className={styles.dialogActions}>
        <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => setConfirmation(null)}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" disabled={disabled} onClick={() => { void remove(); }}>Delete</NeumorphicButton>
      </div>
    </Modal>}
  </section>;
}
