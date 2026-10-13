import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { NeumorphicButton } from './NeumorphicButton';
import { NeumorphicTextField } from './NeumorphicTextField';
import styles from './RenameDialog.module.css';

export function RenameDialog({ initialTitle, heading, inputLabel, maxLength, onSave, onClose }: {
  initialTitle: string;
  heading: string;
  inputLabel: string;
  maxLength?: number;
  onSave(title: string): Promise<unknown>;
  onClose(): void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const close = () => { if (!saving.current) onClose(); };
  const save = async () => {
    if (saving.current || !title.trim()) return;
    if (title.trim() === initialTitle) { onClose(); return; }
    saving.current = true;
    setPending(true);
    setError(null);
    try { await onSave(title.trim()); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { saving.current = false; setPending(false); }
  };
  return <Modal title={heading} titleIcon={<Pencil aria-hidden="true" />} headerVariant="section"
    closeButtonVariant="ghost" className={styles.dialog} closeDisabled={pending} onClose={close}>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}>
      <NeumorphicTextField ref={input} aria-label={inputLabel} maxLength={maxLength} value={title} disabled={pending}
        onFocus={event => event.currentTarget.select()} onChange={event => setTitle(event.target.value)} />
      {error && <p role="alert">{error}</p>}
      <div className={styles.buttons}>
        <NeumorphicButton variant="ghost" type="button" disabled={pending} onClick={close}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" type="submit" disabled={pending || !title.trim()} aria-busy={pending}>
          {pending ? 'Saving…' : 'Save'}
        </NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
