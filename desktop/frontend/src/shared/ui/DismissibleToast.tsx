import { X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { LiquidGlassPanel } from './LiquidGlassPanel';
import { NeumorphicButton } from './NeumorphicButton';
import styles from './DismissibleToast.module.css';

export interface DismissibleToastProps {
  className?: string;
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onDismiss: () => void;
  dismissLabel?: string;
}

export function DismissibleToast({
  className,
  title,
  icon,
  description,
  children,
  footer,
  onDismiss,
  dismissLabel = 'Close notification',
}: DismissibleToastProps) {
  const titleId = useId();

  return createPortal(
    <LiquidGlassPanel
      as="aside"
      role="region"
      aria-labelledby={titleId}
      className={className ? `${styles.card} ${className}` : styles.card}
      data-liquid-glass-backdrop="true"
    >
      <header className={styles.header}>
        {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
        <div className={styles.heading}>
          <h2 id={titleId} className={styles.title}>{title}</h2>
          {description && <div className={styles.description}>{description}</div>}
        </div>
        <NeumorphicButton
          raised
          className={styles.close}
          aria-label={dismissLabel}
          title={dismissLabel}
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </NeumorphicButton>
      </header>
      <div className={styles.body} tabIndex={0}>{children}</div>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </LiquidGlassPanel>,
    document.body,
  );
}
