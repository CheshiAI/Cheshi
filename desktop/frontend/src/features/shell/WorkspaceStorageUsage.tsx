import { HardDrive } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LoadingIndicator } from '../../shared/ui';
import type { WorkspaceDiskUsage } from '../../../../shared/workspace-disk-usage';
import { observeWorkspaceStorage, workspaceStorageLabels } from './workspaceStorageModel';
import styles from './WorkspaceStorageUsage.module.css';

export function WorkspaceStorageUsage() {
  const read = cheshiDesktop?.getWorkspaceDiskUsage;
  const [usage, setUsage] = useState<WorkspaceDiskUsage | null>(null);
  const [loading, setLoading] = useState(Boolean(read));
  useEffect(() => {
    if (!read) return;
    return observeWorkspaceStorage(read, value => { setUsage(value); setLoading(false); });
  }, [read]);
  const labels = usage ? workspaceStorageLabels(usage) : null;
  return (
    <div className={styles.usage} aria-label="Workspace storage" aria-busy={loading}
      title={labels?.title ?? (loading ? 'Calculating workspace storage…' : 'Workspace storage is unavailable.')}>
      <span className={styles.label}><HardDrive aria-hidden="true" />Storage</span>
      <span className={styles.value}>
        {loading ? <LoadingIndicator label="Calculating workspace storage" />
          : labels ? `${labels.size} · ${labels.percent}` : 'Unavailable'}
      </span>
    </div>
  );
}
