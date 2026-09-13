import type { ReactNode } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { NeumorphicButton } from '../../../shared/ui';
import styles from './WorkspaceManager.module.css';

export function WorkspaceManagerHeader({ title, icon, busy = false, onBack }: {
  title: string;
  icon: ReactNode;
  busy?: boolean;
  onBack?: () => void;
}) {
  return <header className={styles.titlebar}>
    {onBack && <NeumorphicButton raised size="icon" className={styles.backButton} disabled={busy}
      autoFocus aria-label="Back to Workspaces" title="Back to Workspaces" onClick={onBack}><ArrowLeft aria-hidden="true" /></NeumorphicButton>}
    <NeumorphicButton raised disabled aria-hidden="true" className={`theme-toggle ${styles.titleMark}`}>{icon}</NeumorphicButton>
    <h1>{title}</h1>
    <NeumorphicButton raised size="icon" className={styles.closeButton} disabled={busy}
      aria-label="Close Workspaces" title="Close Workspaces" onClick={() => window.close()}><X aria-hidden="true" /></NeumorphicButton>
  </header>;
}
