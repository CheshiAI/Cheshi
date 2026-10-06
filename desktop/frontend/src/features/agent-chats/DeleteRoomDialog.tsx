import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Modal, NeumorphicButton } from '../../shared/ui';
import styles from '../chat/ChatSplitDialog.module.css';

export function DeleteRoomDialog({ name, blocked, onDelete, onClose }: {
  name: string; blocked: boolean; onDelete(): Promise<void>; onClose(): void;
}) {
  const guard = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const close = () => { if (!guard.current) onClose(); };
  const remove = async () => {
    if (guard.current || blocked) return;
    guard.current = true; setPending(true); setError(null);
    try { await onDelete(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete this room.'); }
    finally { guard.current = false; setPending(false); }
  };
  return <Modal title="DELETE ROOM" titleIcon={<Trash2 aria-hidden="true" />} headerVariant="section" closeButtonVariant="ghost"
    className={styles.recordDeletionDialog} closeDisabled={pending} onClose={close}>
    <form className={`${styles.form} ${styles.sessionDeletionForm}`} onSubmit={event => { event.preventDefault(); void remove(); }}>
      <p className={styles.sessionTitle}>{name}</p>
      <p>This permanently deletes this room and its Chats conversation and delivery history.<br />This cannot be undone.</p>
      {(error || blocked) && <p role="alert">{error ?? 'This room has pending or unresolved work. Finish or inspect it before deleting the room.'}</p>}
      <div className={styles.buttons}>
        <NeumorphicButton variant="standard" autoFocus type="button" disabled={pending} onClick={close}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" type="submit" disabled={pending || blocked} aria-busy={pending}>{pending ? 'Deleting…' : 'Delete room'}</NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
