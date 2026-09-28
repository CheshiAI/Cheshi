import { FingerprintPattern } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppleNotesApi } from '../../../../shared/apple-notes';
import { NeumorphicButton } from '../../shared/ui';
import styles from './LockedNoteState.module.css';

export function LockedNoteState({ api, noteId }: { api: Pick<AppleNotesApi, 'open'>; noteId: string }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const open = async () => {
    if (pending.current) return;
    pending.current = true;
    setOpening(true);
    setError(null);
    try {
      await api.open(noteId);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not open this note in Apple Notes. Please try again.');
    } finally {
      pending.current = false;
      if (mounted.current) setOpening(false);
    }
  };

  return <div className={styles.root}>
    <FingerprintPattern className={styles.fingerprint} aria-hidden="true" />
    <h2>This note is locked</h2>
    <p>Open this note in Apple Notes to unlock it with Touch ID or your password.</p>
    <NeumorphicButton variant="standard" disabled={opening} aria-busy={opening}
      onClick={() => void open()}>{opening ? 'Opening…' : 'Open in Apple Notes'}</NeumorphicButton>
    {error && <p role="alert">{error}</p>}
  </div>;
}
