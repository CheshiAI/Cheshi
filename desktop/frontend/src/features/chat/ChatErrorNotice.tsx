import { AlertCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import styles from './ChatErrorNotice.module.css';

export function ChatErrorNotice({ children, className, onDismiss, dismissLabel = 'Dismiss error', action }: {
  children: ReactNode;
  className?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  action?: ReactNode;
}) {
  return <LiquidGlassPanel className={className ? `${styles.notice} ${className}` : styles.notice}
    role="alert" data-liquid-glass-backdrop="true">
    <AlertCircle className={styles.icon} aria-hidden="true" />
    <div className={styles.message}>{children}</div>
    {action}
    {onDismiss && <NeumorphicButton raised size="icon" onClick={onDismiss} aria-label={dismissLabel}>
      <X aria-hidden="true" />
    </NeumorphicButton>}
  </LiquidGlassPanel>;
}
