import { TooltipButton } from '../../shared/ui/TooltipButton';
import { AlertCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { ContentCard } from '../../shared/ui';
import styles from './ChatErrorNotice.module.css';

export function ChatErrorNotice({ children, className, onDismiss, dismissLabel = 'Dismiss error', action }: {
  children: ReactNode;
  className?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  action?: ReactNode;
}) {
  return <ContentCard className={className ? `${styles.notice} ${className}` : styles.notice}
    role="alert" icon={<AlertCircle aria-hidden="true" />} title={children}
    actions={(action || onDismiss) ? <>
      {action}
      {onDismiss && <TooltipButton variant="ghost" size="icon" onClick={onDismiss}
        aria-label={dismissLabel} title={dismissLabel}>
        <X aria-hidden="true" />
      </TooltipButton>}
    </> : undefined} />;
}
