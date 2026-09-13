import { ChevronRight } from 'lucide-react';

import { LiquidGlassPanel } from '../../shared/ui';
import { cheshiDesktop } from '../../cheshiDesktop';
import styles from './WorkspaceFileBreadcrumbs.module.css';

interface WorkspaceFileBreadcrumbsProps {
  filePath: string;
}

export function WorkspaceFileBreadcrumbs({ filePath }: WorkspaceFileBreadcrumbsProps) {
  const segments = [cheshiDesktop?.workspaceName ?? 'Workspace', ...filePath.split('/').filter(Boolean)];
  const fullPath = cheshiDesktop?.workspaceRoot
    ? `${cheshiDesktop.workspaceRoot.replace(/\/$/, '')}/${filePath}`
    : filePath;

  return (
    <LiquidGlassPanel
      className={styles.bar}
      role="navigation"
      aria-label="Current file path"
      tabIndex={0}
      title={fullPath}
    >
      <ol className={styles.list}>
        {segments.map((segment, index) => (
          <li key={index} aria-current={index === segments.length - 1 ? 'location' : undefined}>
            {index > 0 && <ChevronRight aria-hidden="true" />}
            <span>{segment}</span>
          </li>
        ))}
      </ol>
    </LiquidGlassPanel>
  );
}
