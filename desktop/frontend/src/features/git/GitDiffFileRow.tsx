import { FileInput } from 'lucide-react';

import { TooltipButton } from '../../shared/ui/TooltipButton';
import styles from './GitWorkspace.module.css';

interface GitDiffFileRowProps {
  path: string;
  selected: boolean;
  onSelectPath: (path: string) => void;
  onOpenWorkspaceFile?: (path: string) => void;
}

export function GitDiffFileRow({ path, selected, onSelectPath, onOpenWorkspaceFile }: GitDiffFileRowProps) {
  return (
    <div className={styles.diffFileRow} data-selected={selected ? 'true' : undefined}>
      <button
        className={styles.diffFileSelect}
        aria-current={selected ? 'page' : undefined}
        title={path}
        type="button"
        onClick={() => onSelectPath(path)}
      >
        {path}
      </button>
      {onOpenWorkspaceFile && <TooltipButton
        variant="ghost"
        size="icon"
        className={styles.diffFileOpen}
        aria-label={`Open file in editor: ${path}`}
        title="Open file in editor"
        onClick={() => onOpenWorkspaceFile(path)}
      >
        <FileInput aria-hidden="true" />
      </TooltipButton>}
    </div>
  );
}
