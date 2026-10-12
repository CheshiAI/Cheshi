import type { ReactNode } from 'react';
import { FolderTree } from 'lucide-react';
import { EmptyState } from '../../shared/ui';
import { SidebarPanelHeader } from '../../shared/ui/SidebarPanelHeader';
import { WorkspaceLayoutControls } from '../shell/WorkspaceLayoutControls';
import styles from './ExplorerView.module.css';

export function ExplorerHeader({ actions }: { actions?: ReactNode }) {
  return <SidebarPanelHeader icon={<FolderTree aria-hidden="true" />} title="EXPLORER" actions={actions} />;
}

export function ExplorerEmptyState() {
  return <EmptyState className={styles.empty} title="Explorer" description="Select a file to view its contents." />;
}

export function ExplorerView() {
  return <section className={styles.view} aria-label="Explorer">
    <ExplorerHeader actions={<WorkspaceLayoutControls />} />
    <ExplorerEmptyState />
  </section>;
}
