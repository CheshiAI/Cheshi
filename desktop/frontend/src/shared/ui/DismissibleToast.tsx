import { X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAutoHideScrollbars } from '../useAutoHideScrollbars';

import { LiquidGlassPanel } from './LiquidGlassPanel';
import { NeumorphicButton } from './NeumorphicButton';
import styles from './DismissibleToast.module.css';

export interface DismissibleToastProps {
  className?: string;
  placement?: 'left' | 'right' | 'bottom-left' | 'bottom-right' | 'top-right';
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onDismiss: () => void;
  dismissLabel?: string;
  closeButtonVariant?: 'standard' | 'ghost';
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
  closeButtonVariant = 'standard',
  placement = 'right',
}: DismissibleToastProps) {
  const titleId = useId();
  const scrollbarSurface = useAutoHideScrollbars<HTMLDivElement>();

  return createPortal(
    <div ref={scrollbarSurface} className={`${styles.popupAnchor} ${placement === 'left' || placement === 'bottom-left' ? styles.anchorLeft : placement === 'top-right' ? styles.anchorTopRight : ''}`}>
      <LiquidGlassPanel
        as="aside"
        role="region"
        aria-labelledby={titleId}
        className={className ? `${styles.popup} ${className}` : styles.popup}
        data-liquid-glass-backdrop="true"
      >
        <header className={styles.header}>
          {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
          <div className={styles.heading}>
            <h2 id={titleId} className={styles.title}>{title}</h2>
            {description && <div className={styles.description}>{description}</div>}
          </div>
          <NeumorphicButton
            variant={closeButtonVariant}
            size="icon"
            aria-label={dismissLabel}
            title={dismissLabel}
            onClick={onDismiss}
          >
            <X aria-hidden="true" />
          </NeumorphicButton>
        </header>
        <div className={styles.body} tabIndex={0}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </LiquidGlassPanel>
    </div>,
    document.body,
  );
}
