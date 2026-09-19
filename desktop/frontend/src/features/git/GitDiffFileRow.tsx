import { FileInput } from 'lucide-react';

import { NeumorphicButton } from '../../shared/ui';
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
      {onOpenWorkspaceFile && <NeumorphicButton
        raised
        className={`sidebar-heading-action ${styles.diffFileOpen}`}
        aria-label={`Open file in editor: ${path}`}
        title="Open file in editor"
        onClick={() => onOpenWorkspaceFile(path)}
      >
        <FileInput aria-hidden="true" />
      </NeumorphicButton>}
    </div>
  );
}
