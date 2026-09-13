import { Copy, History, X } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import { focusAdjacentMenuItem, useContextMenuInteractions } from './contextMenuInteractions';
import { LiquidGlassPanel } from './LiquidGlassPanel';
import styles from './FlatTabContextMenu.module.css';

export interface FlatTabContextMenuTarget {
  x: number;
  y: number;
  title: string;
  trigger: HTMLButtonElement;
  onCopyFullPath?: () => void;
  onOpenLocalHistory?: () => void;
}

interface FlatTabContextMenuProps {
  target: FlatTabContextMenuTarget;
  onClose: () => void;
  onCloseAll: () => void;
}

const MENU_WIDTH = 180;
const MENU_HEIGHT = 94;
const MENU_ITEM_HEIGHT = 40;
const VIEWPORT_GAP = 8;

function menuCoordinate(position: number, viewportSize: number, menuSize: number) {
  return Math.max(VIEWPORT_GAP, Math.min(position, viewportSize - menuSize - VIEWPORT_GAP));
}

export function FlatTabContextMenu({ target, onClose, onCloseAll }: FlatTabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useContextMenuInteractions(menuRef, onClose);

  const runAction = (action: (() => void) | undefined) => {
    if (!action) return;
    onClose();
    action();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="liquid-glass-context-menu-anchor"
      style={{
        left: menuCoordinate(target.x, window.innerWidth, MENU_WIDTH),
        top: menuCoordinate(target.y, window.innerHeight, MENU_HEIGHT + (target.onOpenLocalHistory ? MENU_ITEM_HEIGHT : 0)),
        width: MENU_WIDTH,
      }}
    >
      <LiquidGlassPanel
        className={`liquid-glass-context-menu ${styles.menu}`}
        role="menu"
        aria-label={`Tab actions for ${target.title}`}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={focusAdjacentMenuItem}
      >
        {target.onOpenLocalHistory && (
          <button className="liquid-glass-menu-item" type="button" role="menuitem"
            onClick={() => runAction(target.onOpenLocalHistory)}>
            <span>Local history</span>
            <History aria-hidden="true" />
          </button>
        )}
        <button className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => runAction(onCloseAll)}>
          <span>Close all tabs</span>
          <X aria-hidden="true" />
        </button>
        <button
          className={`liquid-glass-menu-item ${styles.item}`}
          type="button"
          role="menuitem"
          disabled={!target.onCopyFullPath}
          onClick={() => runAction(target.onCopyFullPath)}
        >
          <span>Copy full path</span>
          <Copy aria-hidden="true" />
        </button>
      </LiquidGlassPanel>
    </div>,
    document.body,
  );
}
