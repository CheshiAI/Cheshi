import { BookOpen } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import { focusAdjacentMenuItem, LiquidGlassPanel, useContextMenuInteractions } from '../../shared/ui';
import type { CodeExplanationMenuTarget } from './useWorkspaceCodeExplanation';
import styles from './WorkspaceCodeExplanationMenu.module.css';

interface WorkspaceCodeExplanationMenuProps {
  target: CodeExplanationMenuTarget;
  onClose: () => void;
  onExplain: () => void;
}

export function WorkspaceCodeExplanationMenu({ target, onClose, onExplain }: WorkspaceCodeExplanationMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useContextMenuInteractions(menuRef, onClose);

  return createPortal(
    <div
      ref={menuRef}
      className="liquid-glass-context-menu-anchor"
      style={{
        left: Math.max(8, Math.min(target.x, window.innerWidth - 188)),
        top: Math.max(8, Math.min(target.y, window.innerHeight - 62)),
        width: 180,
      }}
    >
      <LiquidGlassPanel
        className={`liquid-glass-context-menu ${styles.menu}`}
        role="menu"
        aria-label="Selected code actions"
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={focusAdjacentMenuItem}
      >
        <button className="liquid-glass-menu-item" type="button" role="menuitem" onClick={onExplain}>
          <span>Explain code</span>
          <BookOpen aria-hidden="true" />
        </button>
      </LiquidGlassPanel>
    </div>,
    document.body,
  );
}
