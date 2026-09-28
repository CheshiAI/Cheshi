import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { LoadingState, Modal, NeumorphicButton } from '../../shared/ui';
import styles from './ChatSplitDialog.module.css';

interface DeleteRecordProps {
  recordTitle: string;
  kind: 'history' | 'turn';
  pending: boolean;
  error: string | null;
  onClose: () => void;
}

export function ChatDeleteRecordForm({ recordTitle, kind, pending, error, onDelete, onClose, formRef }:
  DeleteRecordProps & { onDelete: () => void; formRef?: RefObject<HTMLFormElement | null> }) {
  return <form ref={formRef} className={styles.form} onSubmit={(event) => {
    event.preventDefault();
    if (!pending) onDelete();
  }}>
    <TooltipTarget content={recordTitle}><p className={styles.sessionTitle}>{recordTitle}</p></TooltipTarget>
    <p>{kind === 'history' ? 'This deletes only the saved conversation history record.' : 'This deletes only the saved turn.'}
      {kind === 'history' ? <br /> : ' '}Your original chat sessions are unaffected.<br />This cannot be undone.</p>
    {error && <p role="alert">{error}</p>}
    <div className={styles.deletionActions}>
      {pending && <LoadingState type="processing" label="Deleting saved record…" className={styles.deletionProgress} />}
      <div className={styles.buttons}>
        <NeumorphicButton name="cancel" variant="standard" disabled={pending} onClick={onClose}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" type="submit" disabled={pending} aria-busy={pending}>{kind === 'history' ? 'Delete history' : 'Delete saved turn'}</NeumorphicButton>
      </div>
    </div>
  </form>;
}

export function ChatDeleteRecordDialog({ onDelete, ...props }: DeleteRecordProps & { onDelete: () => Promise<boolean> }) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Run after the child Modal opens the native dialog and assigns its initial focus.
    formRef.current?.querySelector<HTMLButtonElement>('button[name="cancel"]')?.focus({ preventScroll: true });
  }, []);
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
  return <Modal className={styles.recordDeletionDialog} headerVariant="section" closeButtonVariant="ghost"
    title={props.kind === 'history' ? 'DELETE CONVERSATION HISTORY' : 'DELETE SAVED TURN'}
    titleIcon={<Trash2 aria-hidden="true" />} closeDisabled={busy} onClose={close}>
    <ChatDeleteRecordForm {...props} formRef={formRef} pending={busy} error={failure ? props.error || failure : null}
      onDelete={() => void remove()} onClose={close} />
  </Modal>;
}
