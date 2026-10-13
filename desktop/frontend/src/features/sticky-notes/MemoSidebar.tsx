import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { StickyNotesLibraryApi } from '../../../../shared/sticky-notes';
import { StickyNotesList } from './StickyNotesList';
import styles from './StickyNotes.module.css';

export function MemoSidebar({ api, target }: { api?: StickyNotesLibraryApi; target: HTMLElement | null }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    if (!api || creating) return;
    setCreating(true); setError(null);
    try { await api.create(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not create a note.'); }
    finally { setCreating(false); }
  }
  if (!target) return null;
  return createPortal(<section className={styles.sidebar} aria-label="Memo notes">
    {error && <p className={styles.notice} role="alert">{error}</p>}
    {api ? <StickyNotesList api={api} locked={creating} onNew={() => { void create(); }} onOpen={id => api.open(id)} />
      : <p className={styles.notice}>Restart Cheshi to load your notes.</p>}
  </section>, target);
}
