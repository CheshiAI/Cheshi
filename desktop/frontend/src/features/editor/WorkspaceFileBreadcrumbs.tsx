import { workspaceFullPath } from '../../../../shared/workspace-projects';
import { useWorkspaceProjects } from '../../shared/workspaceProjects';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { ChevronRight } from 'lucide-react';

import { LiquidGlassPanel } from '../../shared/ui';
import { cheshiDesktop } from '../../cheshiDesktop';
import styles from './WorkspaceFileBreadcrumbs.module.css';

interface WorkspaceFileBreadcrumbsProps {
  filePath: string;
}

export function WorkspaceFileBreadcrumbs({ filePath }: WorkspaceFileBreadcrumbsProps) {
  const { projects } = useWorkspaceProjects();
  const project = projects.find(entry => filePath.startsWith(entry.rootPath + '/')) ?? projects[0];
  const relative = project && filePath.startsWith(project.rootPath + '/') ? filePath.slice(project.rootPath.length + 1) : filePath;
  const segments = [project?.name ?? 'Workspace', ...relative.split('/').filter(Boolean)];
  const fullPath = cheshiDesktop?.workspaceRoot
    ? workspaceFullPath(cheshiDesktop.workspaceRoot, filePath)
    : filePath;

  return (
    <TooltipTarget content={fullPath}>
      <LiquidGlassPanel
        className={styles.bar}
        role="navigation"
        aria-label="Current file path"
        tabIndex={0}
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
    </TooltipTarget>
  );
}
