import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { LiquidGlassPanel } from './LiquidGlassPanel';
import { NeumorphicButton } from './NeumorphicButton';
import styles from './Modal.module.css';

interface ModalProps {
  title: string;
  titleIcon?: ReactNode;
  leadingAction?: ReactNode;
  className?: string;
  children: ReactNode;
  onClose: () => void;
  restoreFocus?: () => boolean;
  closeDisabled?: boolean;
}

export function Modal({ title, titleIcon, leadingAction, className, children, onClose, restoreFocus, closeDisabled = false }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerStartedOutside = useRef(false);
  const restoreFocusRef = useRef(restoreFocus);
  restoreFocusRef.current = restoreFocus;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (restoreFocusRef.current?.() !== false && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className={className ? `${styles.dialog} ${className}` : styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        pointerStartedOutside.current = event.target === event.currentTarget && (
          event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom
        );
      }}
      onPointerCancel={() => { pointerStartedOutside.current = false; }}
      onClick={(event) => {
        if (!closeDisabled && pointerStartedOutside.current && event.target === event.currentTarget) onClose();
        pointerStartedOutside.current = false;
      }}
    >
      <LiquidGlassPanel className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.heading}>
            {leadingAction}
            <h2 id={titleId}>{titleIcon}{title}</h2>
          </div>
          <NeumorphicButton raised className="theme-toggle" aria-label="Close dialog" disabled={closeDisabled} onClick={onClose}>
            <X size={11} strokeWidth={1.7} aria-hidden="true" />
          </NeumorphicButton>
        </header>
        <div className={styles.content}>{children}</div>
      </LiquidGlassPanel>
    </dialog>,
    document.body,
  );
}
