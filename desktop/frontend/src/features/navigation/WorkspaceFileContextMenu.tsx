import { Copy, FilePlus2, FolderInput, FolderPlus, History, Pencil, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  focusAdjacentMenuItem,
  LiquidGlassPanel,
  useContextMenuInteractions,
} from '../../shared/ui';
import type { CheshiWorkspaceEntry } from '../../cheshiDesktop';

const contextMenuWidth = 180;
const contextMenuViewportGap = 8;
const contextMenuItemHeight = 36;
const contextMenuItemGap = 4;
const contextMenuPadding = 16;
const contextMenuDividerHeight = 1;

export interface WorkspaceFileContextMenuTarget {
  directoryPath: string;
  entry: CheshiWorkspaceEntry | null;
  x: number;
  y: number;
}

interface WorkspaceFileContextMenuProps extends WorkspaceFileContextMenuTarget {
  onClose: () => void;
  onCopyFullPath: (entry: CheshiWorkspaceEntry) => void;
  onCreate: (directoryPath: string, kind: 'file' | 'directory') => void;
  onDelete: (entry: CheshiWorkspaceEntry) => void;
  onMove: (entry: CheshiWorkspaceEntry) => void;
  onRename: (entry: CheshiWorkspaceEntry) => void;
  onOpenLocalHistory?: (entry: CheshiWorkspaceEntry) => void;
}

function clampedCoordinate(value: number, viewportSize: number, menuSize: number): number {
  return Math.max(
    contextMenuViewportGap,
    Math.min(value, viewportSize - menuSize - contextMenuViewportGap),
  );
}

export function WorkspaceFileContextMenu({
  directoryPath,
  entry,
  x,
  y,
  onClose,
  onCopyFullPath,
  onCreate,
  onDelete,
  onMove,
  onRename,
  onOpenLocalHistory,
}: WorkspaceFileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useContextMenuInteractions(menuRef, onClose);

  const canCreate = entry === null || entry.kind === 'directory';
  const hasDivider = canCreate && entry !== null;
  const canShowHistory = entry?.kind === 'file' && Boolean(onOpenLocalHistory);
  const itemCount = (canCreate ? 2 : 0) + (entry ? 4 : 0) + (canShowHistory ? 1 : 0);
  const childCount = itemCount + (hasDivider ? 1 : 0);
  const contextMenuHeight = contextMenuPadding
    + itemCount * contextMenuItemHeight
    + Math.max(0, childCount - 1) * contextMenuItemGap
    + (hasDivider ? contextMenuDividerHeight : 0);
  const left = clampedCoordinate(x, window.innerWidth, contextMenuWidth);
  const top = clampedCoordinate(y, window.innerHeight, contextMenuHeight);

  return createPortal(
    <div
      ref={menuRef}
      className="workspace-file-context-menu-anchor"
      style={{ left, top, width: contextMenuWidth }}
    >
      <LiquidGlassPanel
        className="workspace-file-context-menu"
        role="menu"
        aria-label={entry ? `Actions for ${entry.name}` : 'Workspace actions'}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={focusAdjacentMenuItem}
      >
        {canCreate && (
          <>
            <button className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => onCreate(directoryPath, 'file')}>
              <span>New file</span>
              <FilePlus2 aria-hidden="true" />
            </button>
            <button className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => onCreate(directoryPath, 'directory')}>
              <span>New folder</span>
              <FolderPlus aria-hidden="true" />
            </button>
          </>
        )}
        {hasDivider && <div className="workspace-file-context-menu-divider" role="separator" />}
        {entry && (
          <>
            {canShowHistory && <button className="liquid-glass-menu-item" type="button" role="menuitem"
              onClick={() => onOpenLocalHistory?.(entry)}>
              <span>Local history</span><History aria-hidden="true" />
            </button>}
            <button className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => onRename(entry)}>
              <span>Rename</span>
              <Pencil aria-hidden="true" />
            </button>
            <button className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => onMove(entry)}>
              <span>Move to…</span>
              <FolderInput aria-hidden="true" />
            </button>
            <button className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => onCopyFullPath(entry)}>
              <span>Copy full path</span>
              <Copy aria-hidden="true" />
            </button>
            <button className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => onDelete(entry)}>
              <span>Delete</span>
              <Trash2 aria-hidden="true" />
            </button>
          </>
        )}
      </LiquidGlassPanel>
    </div>,
    document.body,
  );
}
