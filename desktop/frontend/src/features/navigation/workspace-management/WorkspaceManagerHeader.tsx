import type { ReactNode } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { NeumorphicButton } from '../../../shared/ui';
import { SidebarPanelHeader, SidebarPanelTitle } from '../../../shared/ui/SidebarPanelHeader';
import styles from './WorkspaceManager.module.css';

export function WorkspaceManagerHeader({ title, icon, busy = false, onBack }: {
  title: string;
  icon: ReactNode;
  busy?: boolean;
  onBack?: () => void;
}) {
  return <SidebarPanelHeader title={title.toUpperCase()} titleContent={<div className={styles.titleGroup}>
    {onBack && <NeumorphicButton variant="ghost" size="icon" className={styles.backButton} disabled={busy}
      autoFocus aria-label="Back to Workspaces" title="Back to Workspaces" onClick={onBack}><ArrowLeft aria-hidden="true" /></NeumorphicButton>}
    <SidebarPanelTitle as="h1" title={title.toUpperCase()} icon={icon} />
  </div>} actions={<NeumorphicButton variant="ghost" size="icon" disabled={busy}
    aria-label="Close Workspaces" title="Close Workspaces" onClick={() => window.close()}><X aria-hidden="true" /></NeumorphicButton>} />;
}
