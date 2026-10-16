import { Modal, NeumorphicButton } from '../../shared/ui';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import styles from './HomieHostToolDetails.module.css';

export function HomieHostToolDetails({ text, onClose }: { text: string; onClose(back: boolean): void }) {
  const scrollRef = useAutoHideScrollbars<HTMLPreElement>();
  return <Modal title="Host tool details" headerVariant="section" closeButtonVariant="ghost"
    className={styles.modal} onClose={() => onClose(false)}>
    <div className={styles.body}>
      <p className="description">Read-only details. Return to the confirmation to allow this tool.</p>
      <pre ref={scrollRef} className={styles.details} tabIndex={0} aria-label="Host tool review details">{text}</pre>
      <footer className={styles.actions}>
        <NeumorphicButton variant="ghost" onClick={() => onClose(false)}>Cancel</NeumorphicButton>
        <NeumorphicButton variant="standard" onClick={() => onClose(true)}>Back to confirmation</NeumorphicButton>
      </footer>
    </div>
  </Modal>;
}
