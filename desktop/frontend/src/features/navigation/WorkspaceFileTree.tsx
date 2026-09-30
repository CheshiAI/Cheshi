import {
  Eye,
  EyeOff,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';

import { SidebarPanelHeader } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { PullToRefreshStatus } from '../../shared/ui/PullToRefreshStatus';
import { usePullToRefresh } from '../../shared/usePullToRefresh';
import {
  cheshiDesktop as workspace,
  type CheshiWorkspaceEntry,
  type WorkspaceEntryMutation,
} from '../../cheshiDesktop';
import { WorkspaceFileContextMenu } from './WorkspaceFileContextMenu';
import { WorkspaceFileTreeRows } from './WorkspaceFileTreeRows';
import { useWorkspaceFileTreeController } from './useWorkspaceFileTreeController';
import { WorkspaceDeleteEntryDialog } from './WorkspaceDeleteEntryDialog';

const workspaceName = workspace?.workspaceName ?? 'Workspace';

interface WorkspaceFileTreeProps {
  selectedPath: string | null;
  onEntryMutation: (mutation: WorkspaceEntryMutation) => void;
  onOpenFile: (path: string) => void;
  onOpenLocalHistory?: (path: string) => void;
}

export function WorkspaceFileTree({ selectedPath, onEntryMutation, onOpenFile, onOpenLocalHistory }: WorkspaceFileTreeProps) {
  const [deleteTarget, setDeleteTarget] = useState<CheshiWorkspaceEntry | null>(null);
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
  const refreshDisabled = refreshing || loadingDirectory !== null
    || controller.entryEdit !== null || controller.mutatingPath !== null;
  const refresh = usePullToRefresh(refreshWorkspaceFiles, refreshDisabled);

  return (
    <>
      <section className="workspace-file-tree" aria-label="File explorer">
        <SidebarPanelHeader title="EXPLORER" icon={<Folder aria-hidden="true" />} actions={<>
          <TooltipButton
            size="icon"
            aria-label={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
            aria-pressed={showHiddenFiles}
            title={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
            onClick={() => setShowHiddenFiles((currentValue) => !currentValue)}
          >
            {showHiddenFiles ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          </TooltipButton>
          <TooltipButton
            size="icon"
            aria-busy={refreshing || refresh.refreshing || loadingDirectory !== null}
            aria-label={refreshing || refresh.refreshing ? 'Refreshing project explorer' : 'Refresh project explorer'}
            disabled={refreshDisabled || refresh.refreshing}
            title="Refresh project explorer"
            onClick={() => void refresh.refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </TooltipButton>
          <TooltipButton
            size="icon"
            aria-label="New file in Workspace root"
            title="New file"
            onClick={() => beginCreate('.', 'file')}
          >
            <FilePlus2 aria-hidden="true" />
          </TooltipButton>
          <TooltipButton
            size="icon"
            aria-label="New folder in Workspace root"
            title="New folder"
            onClick={() => beginCreate('.', 'directory')}
          >
            <FolderPlus aria-hidden="true" />
          </TooltipButton>
        </>} />

        <div className="workspace-file-tree-body">
          <PullToRefreshStatus {...refresh} />
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

          <WorkspaceFileTreeRows controller={controller} selectedPath={selectedPath}
            viewportRef={refresh.viewportRef} />
        </div>
      </section>

      {contextMenu && (
        <WorkspaceFileContextMenu
          {...contextMenu}
          onClose={closeContextMenu}
          onCopyFullPath={(entry) => void copyFullPath(entry)}
          onCreate={beginCreate}
          onDelete={(entry) => { closeContextMenu(); setDeleteTarget(entry); }}
          onMove={beginMove}
          onRename={beginRename}
          onOpenLocalHistory={onOpenLocalHistory ? (entry) => { closeContextMenu(); onOpenLocalHistory(entry.path); } : undefined}
        />
      )}
      {deleteTarget && <WorkspaceDeleteEntryDialog entry={deleteTarget}
        onDelete={() => deleteEntry(deleteTarget)} onClose={() => setDeleteTarget(null)} />}
    </>
  );
}
