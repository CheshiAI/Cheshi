import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassPanel } from './LiquidGlassPanel';
import { NeumorphicButton } from './NeumorphicButton';
import { beginSplitPreview } from './splitPreviewState';
import styles from './SplitPreview.module.css';

export type SplitPreviewDirection = 'right' | 'down';
export interface SplitPreviewChoice {
  id: string;
  label: string;
  icon: ReactNode;
  description?: string;
  disabledReason?: string;
}

export function SplitPreview({ target, direction, title, choices, onChoose, onClose, onCommitted }: {
  target: HTMLElement;
  direction: SplitPreviewDirection;
  title: string;
  choices: readonly SplitPreviewChoice[];
  onChoose(id: string): boolean | Promise<boolean>;
  onClose(): void;
  onCommitted?(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const completed = useRef(false);
  const latest = useRef({ onClose, onCommitted });
  latest.current = { onClose, onCommitted };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = target.ownerDocument.activeElement as HTMLElement | null;
    const view = target.ownerDocument.defaultView!;
    const endPreview = beginSplitPreview();
    const previewClass = direction === 'right' ? styles.previewRight! : styles.previewDown!;
    const measure = () => {
      // Measure the original bounds, never the scaled preview's dimensions.
      target.classList.remove(previewClass);
      const bounds = target.getBoundingClientRect();
      Object.assign(dialog.style, {
        left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
      });
      setFits(direction === 'right' ? bounds.width >= 560 && bounds.height >= 240 : bounds.height >= 400 && bounds.width >= 280);
      target.classList.add(previewClass);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    view.addEventListener('resize', measure);
    dialog.showModal();
    return () => {
      observer.disconnect();
      view.removeEventListener('resize', measure);
      target.classList.remove(previewClass);
      dialog.close();
      endPreview();
      if (completed.current) latest.current.onCommitted?.();
      else if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [target, direction]);

  const choose = async (id: string) => {
    if (busyRef.current || !fits) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (await onChoose(id)) {
        completed.current = true;
        latest.current.onClose();
      } else setError('The pane could not be opened. Please try again.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return createPortal(<dialog ref={dialogRef} className={styles.dialog} aria-label={title}
    data-direction={direction} aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <div className={styles.existing} aria-hidden="true"><span>Current layout</span></div>
    <LiquidGlassPanel className={styles.destination}>
      <h2>{title}</h2>
      <p>Open in the new pane</p>
      {!fits && <p role="status">Make this area larger to split it.</p>}
      <div className={styles.choices}>
        {choices.map(choice => <NeumorphicButton key={choice.id} size="standard" className={styles.choice}
          disabled={busy || !fits || Boolean(choice.disabledReason)} title={choice.disabledReason}
          onClick={() => void choose(choice.id)}>
          {choice.icon}<span><strong>{choice.label}</strong>
            {(choice.disabledReason || choice.description) && <small>{choice.disabledReason || choice.description}</small>}
          </span>
        </NeumorphicButton>)}
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Opening pane…</p>}
      <NeumorphicButton size="standard" disabled={busy} onClick={onClose}>Cancel</NeumorphicButton>
    </LiquidGlassPanel>
  </dialog>, target.ownerDocument.body);
}
