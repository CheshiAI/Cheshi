import { Folder, FolderOpen, FolderPlus, LayersPlus, FilePlus2, List, RefreshCw, Unlink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cheshiDesktop, type CheshiDesktopApi, type CheshiWorkspaceEntry, type WorkspaceEntryMutation } from '../../cheshiDesktop';
import { SidebarPanelHeader, Tooltip } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { ToolbarMenu } from '../../shared/ui/ToolbarMenu';
import { OverlayScrollArea } from '../../shared/ui/OverlayScrollArea';
import { PullToRefreshStatus } from '../../shared/ui/PullToRefreshStatus';
import { usePullToRefresh } from '../../shared/usePullToRefresh';
import { useWorkspaceProjects } from '../../shared/workspaceProjects';
import { projectFilePath, type WorkspaceProject } from '../../../../shared/workspace-projects';
import { WorkspaceFileContextMenu } from './WorkspaceFileContextMenu';
import { WorkspaceFileTreeRows } from './WorkspaceFileTreeRows';
import { useWorkspaceFileTreeController } from './useWorkspaceFileTreeController';
import { WorkspaceDeleteEntryDialog } from './WorkspaceDeleteEntryDialog';
import styles from './WorkspaceProjects.module.css';

interface WorkspaceFileTreeProps {
  api?: CheshiDesktopApi;
  selectedPath: string | null;
  onEntryMutation: (mutation: WorkspaceEntryMutation) => void;
  onOpenFile: (path: string) => void;
  onOpenLocalHistory?: (path: string) => void;
}

function ProjectTree({ project, onRemove, busy, active, onActivate, viewport, ...props }: WorkspaceFileTreeProps & {
  project: WorkspaceProject; onRemove(): void; busy: boolean; active: boolean; onActivate(): void;
  viewport: HTMLDivElement | null;
}) {
  const rootPath = projectFilePath(project, '.');
  // Include the whole scene when the project menu extends beyond the sidebar.
  const menuBlurSourceRef = useRef(document.getElementById('app'));
  const controller = useWorkspaceFileTreeController({ ...props, rootPath, project,
    onOpenFile: file => { onActivate(); props.onOpenFile(file); } });
  const [deleteTarget, setDeleteTarget] = useState<CheshiWorkspaceEntry | null>(null);
  const { contextMenu, rootExpanded, closeContextMenu } = controller;
  const disabled = busy || controller.refreshing || controller.mutatingPath !== null
    || controller.loadingDirectory !== null || controller.entryEdit !== null;
  const refresh = usePullToRefresh(controller.refreshWorkspaceFiles, disabled || !active);
  const { viewportRef } = refresh;
  useEffect(() => { viewportRef(active ? viewport : null); }, [active, viewport, viewportRef]);
  return <section className={styles.project} aria-label={`Project ${project.name}`}>
    {active && <PullToRefreshStatus {...refresh} />}
    <div className={styles.rootRow} data-active={active}>
      <Tooltip content={project.rootPath}>{tooltip => <button {...tooltip} className="workspace-file-tree-root" type="button"
        aria-expanded={rootExpanded} onClick={() => { onActivate(); controller.toggleDirectory(rootPath); }}
        onContextMenu={event => controller.openContextMenu(event, null)}>
        {rootExpanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
        <strong>{project.name}</strong>
        {!project.available && <span className={styles.unavailable}>Unavailable</span>}
      </button>}</Tooltip>
      <ToolbarMenu label={`Actions for ${project.name}`} icon={<List aria-hidden="true" />}
        menuBlurSourceRef={menuBlurSourceRef} menuBlurSourceMode="replace" menuClassName={styles.projectMenu} items={[
        { id: 'file', label: 'New file', icon: <FilePlus2 aria-hidden="true" />, disabled: disabled || !project.available, onSelect: () => controller.beginCreate(rootPath, 'file') },
        { id: 'folder', label: 'New folder', icon: <FolderPlus aria-hidden="true" />, disabled: disabled || !project.available, onSelect: () => controller.beginCreate(rootPath, 'directory') },
        { id: 'refresh', label: 'Refresh files', icon: <RefreshCw aria-hidden="true" />, disabled, onSelect: () => { void controller.refreshWorkspaceFiles(); } },
        ...(!project.primary ? [{ id: 'remove', label: 'Remove from workspace', icon: <Unlink aria-hidden="true" />, disabled, onSelect: onRemove }] : []),
      ]} />
    </div>
    <WorkspaceFileTreeRows controller={controller} selectedPath={props.selectedPath} embedded />
    {contextMenu && <WorkspaceFileContextMenu {...contextMenu} onClose={closeContextMenu}
      onCopyFullPath={entry => { void controller.copyFullPath(entry); }} onCreate={controller.beginCreate}
      onDelete={entry => { closeContextMenu(); setDeleteTarget(entry); }} onMove={controller.beginMove} onRename={controller.beginRename}
      onOpenLocalHistory={props.onOpenLocalHistory ? entry => { closeContextMenu(); props.onOpenLocalHistory!(entry.path); } : undefined} />}
    {deleteTarget && <WorkspaceDeleteEntryDialog entry={deleteTarget}
      onDelete={() => controller.deleteEntry(deleteTarget)} onClose={() => setDeleteTarget(null)} />}
  </section>;
}

export function WorkspaceFileTree({ api = cheshiDesktop, ...props }: WorkspaceFileTreeProps) {
  const { projects, error: loadError } = useWorkspaceProjects(api);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('primary');
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const activeId = projects.some(project => project.id === selected) ? selected : 'primary';
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="workspace-file-tree" aria-label="File explorer">
    <SidebarPanelHeader title="EXPLORER" icon={<Folder aria-hidden="true" />} actions={
      <TooltipButton size="icon" aria-label="Add project to workspace" title="Add project to workspace"
        disabled={busy || !api?.workspaceProjects} onClick={() => { void run(() => api!.workspaceProjects!.add()); }}>
        <LayersPlus aria-hidden="true" />
      </TooltipButton>
    } />
    {(error || loadError) && <p role="alert" className="workspace-file-tree-status error">{error || loadError}</p>}
    <OverlayScrollArea className={styles.projects} label="Workspace projects" viewportRef={setViewport}>
      {projects.map(project => <ProjectTree key={project.id} {...props} api={api} project={project} busy={busy} viewport={viewport} active={activeId === project.id} onActivate={() => setSelected(project.id)}
        onRemove={() => { void run(() => api!.workspaceProjects!.remove(project.id)); }} />)}
    </OverlayScrollArea>
  </section>;
}
