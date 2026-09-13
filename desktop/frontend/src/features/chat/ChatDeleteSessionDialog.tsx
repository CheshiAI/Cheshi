import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { LoadingState, Modal, NeumorphicButton } from '../../shared/ui';
import styles from './ChatSplitDialog.module.css';

interface ChatDeleteSessionProps {
  sessionTitle: string;
  reason: string | null;
  pending: boolean;
  error: string | null;
  onDelete: () => void;
  onClose: () => void;
}

export function ChatDeleteSessionForm({ sessionTitle, reason, pending, error, onDelete, onClose }: ChatDeleteSessionProps) {
  return <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (!pending && !reason) onDelete(); }}>
    <p className={styles.sessionTitle} title={sessionTitle}>{sessionTitle}</p>
    <p>This permanently deletes this conversation and its child agent conversations. This cannot be undone.</p>
    {(error || reason) && <p role="alert">{error || reason}</p>}
    <div className={styles.deletionActions}>
      {pending && <LoadingState type="processing" label="Deleting chat…" className={styles.deletionProgress} />}
      <div className={styles.buttons}>
        <NeumorphicButton size="standard" raised autoFocus type="button" disabled={pending} onClick={onClose}>Cancel</NeumorphicButton>
        <NeumorphicButton size="standard" raised type="submit" disabled={pending || reason !== null} aria-busy={pending}>Delete chat</NeumorphicButton>
      </div>
    </div>
  </form>;
}

export function ChatDeleteSessionDialog({ sessionTitle, reason, pending, error, onDelete, onDeleted, onClose }: {
  sessionTitle: string;
  reason: string | null;
  pending: boolean;
  error: string | null;
  onDelete: () => Promise<boolean>;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const pendingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = pending || submitting;
  const close = () => { if (!pendingRef.current && !busy) onClose(); };
  const remove = async () => {
    if (pendingRef.current || busy || reason) return;
    pendingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      if (await onDelete()) onDeleted();
      else setFailure('Could not delete the conversation. Please try again.');
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      setSubmitting(false);
    }
  };
  return <Modal title="Delete chat?" titleIcon={<Trash2 aria-hidden="true" />} closeDisabled={busy} onClose={close}>
    <ChatDeleteSessionForm sessionTitle={sessionTitle} reason={reason} pending={busy} error={error || failure}
      onDelete={() => { void remove(); }} onClose={close} />
  </Modal>;
}
