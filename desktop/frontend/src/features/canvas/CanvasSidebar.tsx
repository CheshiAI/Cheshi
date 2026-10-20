import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Frame, Plus, RefreshCw, Save } from 'lucide-react';
import type { CanvasApi, CanvasLibraryListing } from '../../../../shared/canvas';
import { cheshiDesktop } from '../../cheshiDesktop';
import { NeumorphicButton, SidebarPanelHeader, Tooltip } from '../../shared/ui';
import { InlineRenameField } from '../../shared/ui/InlineRenameField';
import { ToolbarMenu } from '../../shared/ui/ToolbarMenu';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { CanvasFileMenu } from './CanvasFileMenu';
import styles from './CanvasSidebar.module.css';

export function CanvasSidebar({ api, currentPath, busy, ready, canSave, refresh, onOpen, onSave, onCreate, onRename, onError }: {
  api: CanvasApi; currentPath: string; busy: boolean; ready: boolean; canSave: boolean; refresh: number;
  onOpen(path: string): void; onSave(): void; onCreate(): void; onRename(path: string, name: string): Promise<void>;
  onError(error: unknown): void;
}) {
  const [listing, setListing] = useState<CanvasLibraryListing | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const scroll = useAutoHideScrollbars<HTMLDivElement>();
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => cheshiDesktop?.onWorkspaceFilesChanged(event => {
    if (event.overflow || event.paths.some(file => file.endsWith('.fig'))) reload();
  }), [reload]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.list().then(value => { if (!cancelled) setListing(value); })
      .catch(error => { if (!cancelled) onError(error); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, refresh, revision, onError]);
  async function chooseFolder() {
    setChoosing(true); setRenaming(null); closeMenu();
    try { const selected = await api.chooseRoot(); if (selected) { setListing(selected); reload(); } }
    catch (error) { onError(error); }
    finally { setChoosing(false); }
  }
  const disabled = busy || choosing;
  const folder = listing?.canvasRoot;
  const rootName = folder === '.' ? cheshiDesktop?.workspaceName ?? 'Workspace' : folder?.split('/').at(-1);
  return <div className={styles.root} aria-label="Workspace canvases">
    <SidebarPanelHeader title="CANVAS" icon={<Frame aria-hidden="true" />} count={listing?.files.length}
      actions={<>
        <NeumorphicButton variant="ghost" size="icon" aria-label="Save canvas" title="Save canvas (⌘S)" disabled={!ready || !canSave || disabled} onClick={onSave}><Save /></NeumorphicButton>
        <NeumorphicButton variant="ghost" size="icon" aria-label="Refresh canvases" title="Refresh canvases" disabled={loading || disabled} onClick={reload}><RefreshCw /></NeumorphicButton>
        <ToolbarMenu label="Add canvas" icon={<Plus aria-hidden="true" />} disabled={disabled} items={[
          { id: 'new', label: 'New canvas', icon: <Frame aria-hidden="true" />, disabled: !ready, onSelect: onCreate },
          { id: 'folder', label: 'Choose canvas folder', icon: <FolderOpen aria-hidden="true" />, onSelect: () => void chooseFolder() },
        ]} />
      </>} />
    <div ref={scroll} className={styles.scroll}>
      <section className={styles.files} aria-label="Canvas files">
        {folder != null && <Tooltip content={`${listing?.workspaceRoot}/${folder}`}>
          {tooltip => <div {...tooltip} className={`workspace-file-tree-root ${styles.folder}`}>
            <FolderOpen className="workspace-file-tree-icon" aria-hidden="true" /><strong>{rootName}</strong>
          </div>}
        </Tooltip>}
        {loading && !listing && <p role="status">Loading canvases…</p>}
        {listing && folder === null && <p className={styles.description}>Choose a canvas folder with +.</p>}
        {folder != null && listing?.files.length === 0 && <p className={styles.description}>No canvases in this folder. Use + to create a new canvas.</p>}
        <div className="workspace-file-tree-list-content" role="tree" aria-label="Canvas files">
        {listing?.files.map(file => renaming === file.path
          ? <InlineRenameField key={file.path} initialTitle={file.path.split('/').at(-1)!.replace(/\.fig$/, '')}
              inputLabel="Canvas file name" maxLength={200} onClose={() => setRenaming(null)}
              onSave={async name => { await onRename(file.path, name); reload(); }}><span className={styles.description}>.fig</span></InlineRenameField>
          : <Tooltip key={file.path} content={`${listing.workspaceRoot}/${file.path}`}>
            {tooltip => <button {...tooltip} type="button" role="treeitem" className={`workspace-file-tree-entry ${styles.file}`} data-canvas-path={file.path}
              aria-selected={currentPath === file.path} aria-current={currentPath === file.path ? 'page' : undefined}
              data-context-menu-open={menu?.path === file.path}
              disabled={!ready || disabled} onClick={() => onOpen(file.path)}
              onContextMenu={event => { event.preventDefault(); if (!disabled) setMenu({ path: file.path, x: event.clientX, y: event.clientY }); }}
              onKeyDown={event => { if (event.key === 'F2' && !disabled) { event.preventDefault(); setRenaming(file.path); } }}>
              <span className="workspace-file-tree-guides" aria-hidden="true"><span className="workspace-file-tree-guide" /></span>
              <span className="workspace-file-tree-chevron-placeholder" aria-hidden="true" />
              <Frame className="workspace-file-tree-icon" aria-hidden="true" />
              <span className="workspace-file-tree-name">{folder && folder !== '.' ? file.path.slice(folder.length + 1) : file.path}</span>
            </button>}
          </Tooltip>)}
        </div>
        {listing?.truncated && <p className={styles.description}>The file list is limited. Select a smaller canvas folder.</p>}
      </section>
    </div>
    {menu && <CanvasFileMenu x={menu.x} y={menu.y} onClose={closeMenu} onRename={() => { setRenaming(menu.path); closeMenu(); }} />}
  </div>;
}
