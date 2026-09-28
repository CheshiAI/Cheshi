import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { APPLE_NOTES_DELETE_UNKNOWN_MESSAGE, type AppleNoteSummary, type AppleNotesApi } from '../../../../shared/apple-notes';
import { Modal, NeumorphicButton } from '../../shared/ui';
import styles from './AppleNotes.module.css';

export function AppleNotesDeleteDialog({ api, note, onClose, onDeleted }: {
  api: AppleNotesApi; note: AppleNoteSummary; onClose: () => void; onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownResult, setUnknownResult] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const remove = async () => {
    if (pending.current || unknownResult || note.locked !== false) return;
    pending.current = true;
    setDeleting(true);
    setError(null);
    try {
      const result = await api.delete(note.id);
      if (!mounted.current) return;
      if (result.ok === true && result.value.id === note.id) onDeleted();
      else if (result.ok === false) {
        setError(result.error.message);
        setUnknownResult(result.error.code === 'delete-unknown');
      } else {
        setError(APPLE_NOTES_DELETE_UNKNOWN_MESSAGE);
        setUnknownResult(true);
      }
    } catch {
      if (mounted.current) {
        setError(APPLE_NOTES_DELETE_UNKNOWN_MESSAGE);
        setUnknownResult(true);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  return <Modal title="DELETE NOTE" headerVariant="section" closeButtonVariant="ghost" className={styles.deleteDialog}
    titleIcon={<Trash2 aria-hidden="true" />} onClose={onClose} closeDisabled={deleting}>
    <div className={styles.content}>
      <p className={styles.deleteTitle}><strong>{note.title || 'Untitled note'}</strong></p>
      <p className={styles.description}>This deletes the original note from Apple Notes.</p>
      {error && <p className={styles.description} role="alert">{error}</p>}
      <div className={styles.actions}>
        <NeumorphicButton variant="standard" autoFocus disabled={deleting} onClick={onClose}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" disabled={deleting || unknownResult || note.locked !== false} aria-busy={deleting}
          onClick={() => void remove()}>{deleting ? 'Deleting…' : 'Delete note'}</NeumorphicButton>
      </div>
    </div>
  </Modal>;
}
