import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { LoadingState, Modal, NeumorphicButton } from '../../shared/ui';
import styles from './ChatSplitDialog.module.css';

interface DeleteRecordProps {
  recordTitle: string;
  kind: 'history' | 'turn';
  pending: boolean;
  error: string | null;
  onClose: () => void;
}

export function ChatDeleteRecordForm({ recordTitle, kind, pending, error, onDelete, onClose }:
  DeleteRecordProps & { onDelete: () => void }) {
  return <form className={styles.form} onSubmit={(event) => {
    event.preventDefault();
    if (!pending) onDelete();
  }}>
    <p className={styles.sessionTitle} title={recordTitle}>{recordTitle}</p>
    <p>{kind === 'history' ? 'This deletes only the saved conversation history record.' : 'This deletes only the saved turn.'}
      {' '}Your original chat sessions are unaffected. This cannot be undone.</p>
    {error && <p role="alert">{error}</p>}
    <div className={styles.deletionActions}>
      {pending && <LoadingState type="processing" label="Deleting saved record…" className={styles.deletionProgress} />}
      <div className={styles.buttons}>
        <NeumorphicButton size="standard" raised autoFocus disabled={pending} onClick={onClose}>Cancel</NeumorphicButton>
        <NeumorphicButton size="standard" raised type="submit" disabled={pending} aria-busy={pending}>{kind === 'history' ? 'Delete history' : 'Delete saved turn'}</NeumorphicButton>
      </div>
    </div>
  </form>;
}

export function ChatDeleteRecordDialog({ onDelete, ...props }: DeleteRecordProps & { onDelete: () => Promise<boolean> }) {
  const pendingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = props.pending || submitting;
  const close = () => { if (!pendingRef.current && !busy) props.onClose(); };
  const remove = async () => {
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      if (await onDelete()) props.onClose();
      else setFailure('Could not delete the saved record. Please try again.');
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      setSubmitting(false);
    }
  };
  return <Modal title={props.kind === 'history' ? 'Delete conversation history?' : 'Delete saved turn?'}
    titleIcon={<Trash2 aria-hidden="true" />} closeDisabled={busy} onClose={close}>
    <ChatDeleteRecordForm {...props} pending={busy} error={failure ? props.error || failure : null}
      onDelete={() => void remove()} onClose={close} />
  </Modal>;
}
