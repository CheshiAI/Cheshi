import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Modal, NeumorphicButton } from '../ui';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import styles from './WorkerDeleteDialog.module.css';

export function WorkerDeleteDialog({ kind, name, retryDeleteData, onDelete, onClose }: {
  kind: 'agent' | 'container'; name: string; onDelete(deleteData: boolean): Promise<void>; onClose(): void;
  retryDeleteData?: boolean;
}) {
  const [deleteData, setDeleteData] = useState(retryDeleteData ?? false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const close = () => { if (!busy.current) onClose(); };
  const remove = async () => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await onDelete(deleteData); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Deletion failed. Retry to finish cleanup.'); }
    finally { busy.current = false; setPending(false); }
  };
  return <Modal title={kind === 'agent' ? 'DELETE AGENT' : 'DELETE CONTAINER'} titleIcon={<Trash2 aria-hidden="true" />}
    headerVariant="section" closeButtonVariant="ghost" closeDisabled={pending} onClose={close}>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void remove(); }}>
      <p className={styles.name}>{name}</p>
      <p>{kind === 'agent'
        ? 'Delete this agent, all project assignments, and its worker containers across its previously used local engines.'
        : 'Delete this container. Its registered agent and project assignment will remain.'}<br />This cannot be undone.</p>
      <div className={styles.option}><span>Also delete saved data</span><ToggleSwitch aria-label="Also delete saved data"
        checked={deleteData} disabled={pending || retryDeleteData !== undefined} onChange={setDeleteData} /></div>
      {retryDeleteData !== undefined && <p>Finish the previous deletion using its original saved-data choice.</p>}
      <p>{deleteData ? 'Permanently delete the dedicated worker volumes, including conversations, task results, and worker sign-in data.'
        : 'Keep saved conversations, task results, and worker sign-in data in their volumes.'}</p>
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}>
        <NeumorphicButton type="button" variant="standard" autoFocus disabled={pending} onClick={close}>Cancel</NeumorphicButton>
        <NeumorphicButton type="submit" variant="standard" disabled={pending} aria-busy={pending}>
          {pending ? 'Deleting…' : kind === 'agent' ? 'Delete agent' : 'Delete container'}</NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
