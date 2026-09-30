import { useEffect, useState } from 'react';
import type { NotesSearchStatus as SearchStatus } from '../../../../shared/apple-notes-search';
import { cheshiDesktop } from '../../cheshiDesktop';
import styles from './NotesSearchStatus.module.css';

/** Observes the background service; never starts indexing or reads note contents. */
export function NotesSearchStatus() {
  const read = cheshiDesktop?.appleNotes?.searchStatus;
  const [status, setStatus] = useState<SearchStatus | null>(null);
  useEffect(() => {
    if (!read) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try { const next = await read(); if (active) setStatus(next); }
      catch { if (active) setStatus(null); }
      finally { if (active) timer = setTimeout(() => void poll(), 500); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [read]);
  if (!status || (status.state !== 'building' && status.state !== 'updating')) return null;
  const label = status.state === 'building' ? 'Preparing note search' : 'Updating note search';
  return <span className={styles.status} role="status" title={`${label}… ${status.completed}/${status.pending}`}>
    {label}… {status.completed}/{status.pending}
  </span>;
}
