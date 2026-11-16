import { Modal, NeumorphicButton } from '../../shared/ui';
import styles from './CanvasCloseDialog.module.css';

export type CanvasCloseChoice = 'save' | 'discard' | 'cancel';

export function CanvasCloseDialog({ documentName, onChoose }: {
  documentName: string;
  onChoose(choice: CanvasCloseChoice): void;
}) {
  return <Modal title="SAVE CHANGES" headerVariant="section" closeButtonVariant="ghost"
    className={styles.dialog} onClose={() => onChoose('cancel')}>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); onChoose('save'); }}>
      <p className={styles.document}>Save changes to “{documentName || 'Untitled'}”?</p>
      <p className={styles.description}>Your changes will be discarded if you close without saving.</p>
      <div className={styles.actions}>
        <NeumorphicButton variant="ghost" type="button" onClick={() => onChoose('discard')}>Don't Save</NeumorphicButton>
        <NeumorphicButton variant="ghost" type="button" onClick={() => onChoose('cancel')}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" type="submit" autoFocus>Save</NeumorphicButton>
      </div>
    </form>
  </Modal>;
}
