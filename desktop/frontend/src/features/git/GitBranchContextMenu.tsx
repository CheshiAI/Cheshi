import { GitBranch, GitBranchPlus, RefreshCw } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  focusAdjacentMenuItem,
  LiquidGlassPanel,
  NeumorphicButton,
  useContextMenuInteractions,
} from '../../shared/ui';
import { RegionalBlur } from '../../shared/ui/RegionalBlur';
import type { GitBranchSummary } from '../../cheshiDesktop';
import styles from './GitBranchContextMenu.module.css';

const menuWidth = 220;
const viewportGap = 8;

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
  const sourceRef = useRef(document.getElementById('app'));
  useContextMenuInteractions(menuRef, onClose);

  useLayoutEffect(() => {
    const anchor = menuRef.current;
    if (!anchor) return;
    const trigger = document.activeElement;
    const bounds = anchor.getBoundingClientRect();
    anchor.style.left = `${clampedCoordinate(x, window.innerWidth, bounds.width)}px`;
    anchor.style.top = `${clampedCoordinate(y, window.innerHeight, bounds.height)}px`;
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected && anchor.contains(document.activeElement)) trigger.focus();
    };
  }, [x, y]);

  const canCheckout = !branch.remote && !branch.current;
  const left = clampedCoordinate(x, window.innerWidth, menuWidth);
  const run = (operation: (selectedBranch: GitBranchSummary) => void): void => {
    operation(branch);
    onClose();
  };

  return createPortal(
    <RegionalBlur sourceRef={sourceRef} sourceMode="replace">
      <div ref={menuRef} className={styles.anchor} style={{ left, top: y, width: menuWidth }}>
        <LiquidGlassPanel
          aria-label={`Actions for branch ${branch.name}`}
          className={styles.menu}
          role="menu"
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            focusAdjacentMenuItem(event);
            if (event.key === 'Tab') onClose();
          }}
        >
          <NeumorphicButton variant="ghost" disabled={disabled} className={styles.item} role="menuitem" onClick={() => run(onCreateFrom)}>
            <span>New branch from ‘{branch.name}’…</span>
            <GitBranchPlus aria-hidden="true" />
          </NeumorphicButton>
          <div className={styles.separator} role="separator" />
          <NeumorphicButton variant="ghost" disabled={disabled} className={styles.item} role="menuitem" onClick={() => run(onUpdate)}>
            <span>Update</span>
            <RefreshCw aria-hidden="true" />
          </NeumorphicButton>
          {canCheckout && (
            <NeumorphicButton variant="ghost" disabled={disabled} className={styles.item} role="menuitem" onClick={() => run(onCheckout)}>
              <span>Checkout</span>
              <GitBranch aria-hidden="true" />
            </NeumorphicButton>
          )}
        </LiquidGlassPanel>
      </div>
    </RegionalBlur>,
    document.body,
  );
}
