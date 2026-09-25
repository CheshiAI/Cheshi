import {
  Eye,
  EyeOff,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  RotateCw,
} from 'lucide-react';

import { NeumorphicButton, SidebarPanelHeader } from '../../shared/ui';
import {
  cheshiDesktop as workspace,
  type WorkspaceEntryMutation,
} from '../../cheshiDesktop';
import { WorkspaceFileContextMenu } from './WorkspaceFileContextMenu';
import { WorkspaceFileTreeRows } from './WorkspaceFileTreeRows';
import { useWorkspaceFileTreeController } from './useWorkspaceFileTreeController';

const workspaceName = workspace?.workspaceName ?? 'Workspace';

interface WorkspaceFileTreeProps {
  selectedPath: string | null;
  onEntryMutation: (mutation: WorkspaceEntryMutation) => void;
  onOpenFile: (path: string) => void;
  onOpenLocalHistory?: (path: string) => void;
}

export function WorkspaceFileTree({ selectedPath, onEntryMutation, onOpenFile, onOpenLocalHistory }: WorkspaceFileTreeProps) {
  const controller = useWorkspaceFileTreeController({ onEntryMutation, onOpenFile });
  const {
    beginCreate,
    beginMove,
    beginRename,
    closeContextMenu,
    contextMenu,
    copyFullPath,
    deleteEntry,
    loadingDirectory,
    openContextMenu,
    refreshWorkspaceFiles,
    refreshing,
    rootExpanded,
    setShowHiddenFiles,
    showHiddenFiles,
    toggleDirectory,
  } = controller;

  return (
    <>
      <section className="workspace-file-tree" aria-label="File explorer">
        <SidebarPanelHeader title="FILES" icon={<Folder aria-hidden="true" />} actions={<>
          <NeumorphicButton
            raised
            size="icon"
            aria-label={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
            aria-pressed={showHiddenFiles}
            title={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
            onClick={() => setShowHiddenFiles((currentValue) => !currentValue)}
          >
            {showHiddenFiles ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          </NeumorphicButton>
          <NeumorphicButton
            raised
            size="icon"
            aria-busy={refreshing || loadingDirectory !== null}
            aria-label={refreshing ? 'Refreshing project explorer' : 'Refresh project explorer'}
            disabled={refreshing}
            title="Refresh project explorer"
            onClick={() => void refreshWorkspaceFiles()}
          >
            <RotateCw
              className={refreshing || loadingDirectory !== null ? 'workspace-file-tree-spinner' : undefined}
              aria-hidden="true"
            />
          </NeumorphicButton>
          <NeumorphicButton
            raised
            size="icon"
            aria-label="New file in Workspace root"
            title="New file"
            onClick={() => beginCreate('.', 'file')}
          >
            <FilePlus2 aria-hidden="true" />
          </NeumorphicButton>
          <NeumorphicButton
            raised
            size="icon"
            aria-label="New folder in Workspace root"
            title="New folder"
            onClick={() => beginCreate('.', 'directory')}
          >
            <FolderPlus aria-hidden="true" />
          </NeumorphicButton>
        </>} />

        <div className="workspace-file-tree-body">
          <button
            className="workspace-file-tree-root"
            type="button"
            aria-expanded={rootExpanded}
            data-context-menu-open={contextMenu?.entry === null ? 'true' : undefined}
            onClick={() => toggleDirectory('.')}
            onContextMenu={(event) => openContextMenu(event, null)}
          >
            {rootExpanded
              ? <FolderOpen className="workspace-file-tree-icon" aria-hidden="true" />
              : <Folder className="workspace-file-tree-icon" aria-hidden="true" />}
            <strong>{workspaceName}</strong>
          </button>

          <WorkspaceFileTreeRows controller={controller} selectedPath={selectedPath} />
        </div>
      </section>

      {contextMenu && (
        <WorkspaceFileContextMenu
          {...contextMenu}
          onClose={closeContextMenu}
          onCopyFullPath={(entry) => void copyFullPath(entry)}
          onCreate={beginCreate}
          onDelete={(entry) => void deleteEntry(entry)}
          onMove={beginMove}
          onRename={beginRename}
          onOpenLocalHistory={onOpenLocalHistory ? (entry) => { closeContextMenu(); onOpenLocalHistory(entry.path); } : undefined}
        />
      )}
    </>
  );
}
