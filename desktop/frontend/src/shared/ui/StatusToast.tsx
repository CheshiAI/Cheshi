import { CircleCheck, CircleAlert, CircleX, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassPanel } from './LiquidGlassPanel';
import { NeumorphicButton } from './NeumorphicButton';
import styles from './StatusToast.module.css';

export interface StatusToastMessage {
  id: number | string;
  variant: 'success' | 'warning' | 'error';
  title: string;
  description: string;
}

export interface StatusToastProps {
  message: StatusToastMessage;
  onDismiss: () => void;
}

export function StatusToast({ message, onDismiss }: StatusToastProps) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss.current(), 10_000);
    return () => window.clearTimeout(timer);
  }, [message.id]);
  const Icon = { success: CircleCheck, warning: CircleAlert, error: CircleX }[message.variant];

  return createPortal(
    <LiquidGlassPanel as="aside" className={styles.card} data-variant={message.variant}>
      <span className={styles.icon} aria-hidden="true"><Icon /></span>
      <div className={styles.content} role={message.variant === 'error' ? 'alert' : 'status'} aria-atomic="true">
        <strong className={styles.title}>{message.title}</strong>
        <p className={styles.description}>{message.description}</p>
      </div>
      <NeumorphicButton raised className={styles.close} aria-label="Close notification" onClick={onDismiss}>
        <X aria-hidden="true" />
      </NeumorphicButton>
    </LiquidGlassPanel>,
    document.body,
  );
}
