import { GitBranch, GitBranchPlus, RefreshCw } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  focusAdjacentMenuItem,
  LiquidGlassPanel,
  useContextMenuInteractions,
} from '../../shared/ui';
import type { GitBranchSummary } from '../../cheshiDesktop';
import styles from './GitBranchContextMenu.module.css';

const menuWidth = 220;
const viewportGap = 8;
const itemHeight = 36;
const itemGap = 4;
const menuPadding = 16;
const dividerHeight = 1;

export interface GitBranchContextMenuTarget {
  branch: GitBranchSummary;
  x: number;
  y: number;
}

interface GitBranchContextMenuProps extends GitBranchContextMenuTarget {
  disabled: boolean;
  onCheckout: (branch: GitBranchSummary) => void;
  onClose: () => void;
  onCreateFrom: (branch: GitBranchSummary) => void;
  onUpdate: (branch: GitBranchSummary) => void;
}

function clampedCoordinate(value: number, viewportSize: number, size: number): number {
  return Math.max(viewportGap, Math.min(value, viewportSize - size - viewportGap));
}

export function GitBranchContextMenu({
  branch,
  disabled,
  x,
  y,
  onCheckout,
  onClose,
  onCreateFrom,
  onUpdate,
}: GitBranchContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useContextMenuInteractions(menuRef, onClose);

  const canCheckout = !branch.remote && !branch.current;
  const itemCount = canCheckout ? 3 : 2;
  const menuHeight = menuPadding + itemCount * itemHeight + itemCount * itemGap + dividerHeight;
  const left = clampedCoordinate(x, window.innerWidth, menuWidth);
  const top = clampedCoordinate(y, window.innerHeight, menuHeight);
  const run = (operation: (selectedBranch: GitBranchSummary) => void): void => {
    operation(branch);
    onClose();
  };

  return createPortal(
    <div ref={menuRef} className="liquid-glass-context-menu-anchor" style={{ left, top, width: menuWidth }}>
      <LiquidGlassPanel
        aria-label={`Actions for branch ${branch.name}`}
        className={`liquid-glass-context-menu ${styles.menu}`}
        role="menu"
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={focusAdjacentMenuItem}
      >
        <button disabled={disabled} className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => run(onCreateFrom)}>
          <span>New branch from ‘{branch.name}’…</span>
          <GitBranchPlus aria-hidden="true" />
        </button>
        <div className="liquid-glass-context-menu-divider" role="separator" />
        <button disabled={disabled} className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => run(onUpdate)}>
          <span>Update</span>
          <RefreshCw aria-hidden="true" />
        </button>
        {canCheckout && (
          <button disabled={disabled} className="liquid-glass-menu-item" type="button" role="menuitem" onClick={() => run(onCheckout)}>
            <span>Checkout</span>
            <GitBranch aria-hidden="true" />
          </button>
        )}
      </LiquidGlassPanel>
    </div>,
    document.body,
  );
}
