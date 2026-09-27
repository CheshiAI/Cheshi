import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CheshiWorkspaceEntry } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';
import { LoadingState, Modal, NeumorphicButton } from '../../shared/ui';
import styles from './WorkspaceDeleteEntryDialog.module.css';

export function WorkspaceDeleteEntryDialog({ entry, onDelete, onClose }: {
  entry: CheshiWorkspaceEntry;
  onDelete: () => Promise<boolean>;
  onClose: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Modal's effect opens the native dialog before this parent effect runs.
    formRef.current?.querySelector<HTMLButtonElement>('button[name="cancel"]')?.focus({ preventScroll: true });
  }, []);
  const close = () => { if (!pendingRef.current) onClose(); };
  const remove = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (await onDelete()) onClose();
      else setError('Another file operation is in progress. Please try again.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return <Modal title="MOVE TO TRASH" titleIcon={<Trash2 aria-hidden="true" />} headerVariant="section"
    className={styles.dialog} closeDisabled={pending} onClose={close}>
    <form ref={formRef} className={styles.form} aria-busy={pending} onSubmit={(event) => {
      event.preventDefault();
      void remove();
    }}>
      <p className={styles.name}>{entry.name}</p>
      <p className={styles.description}>{entry.path}</p>
      <p className={styles.description}>{entry.kind === 'directory'
        ? 'This folder and its contents will be moved to Trash.'
        : 'This file will be moved to Trash.'} You can restore it from Trash.</p>
      {error && <p className={styles.description} role="alert">{error}</p>}
      {pending && <LoadingState type="processing" label="Moving to Trash…" />}
      <div className={styles.actions}>
        <NeumorphicButton name="cancel" variant="standard" disabled={pending} onClick={close}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" type="submit" disabled={pending} aria-busy={pending}>Move to Trash</NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
