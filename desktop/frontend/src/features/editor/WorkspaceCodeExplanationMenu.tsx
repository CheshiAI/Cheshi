import { BookOpen, GitCommitHorizontal } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import { focusAdjacentMenuItem, LiquidGlassPanel, NeumorphicButton, useContextMenuInteractions } from '../../shared/ui';
import type { CodeExplanationMenuTarget } from './useWorkspaceCodeExplanation';
import styles from '../../shared/ui/ContextMenu.module.css';

interface WorkspaceCodeExplanationMenuProps {
  target: CodeExplanationMenuTarget;
  onClose: () => void;
  onExplain: () => void;
  onShowLineCommit: () => void;
}

export function WorkspaceCodeExplanationMenu({ target, onClose, onExplain, onShowLineCommit }: WorkspaceCodeExplanationMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useContextMenuInteractions(menuRef, onClose);

  return createPortal(
    <div
      ref={menuRef}
      className={styles.anchor}
      style={{
        left: Math.max(8, Math.min(target.x, window.innerWidth - 188)),
        top: Math.max(8, Math.min(target.y, window.innerHeight - 94)),
        width: 180,
      }}
    >
      <LiquidGlassPanel
        className={styles.menu}
        role="menu"
        aria-label="Code actions"
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={focusAdjacentMenuItem}
      >
        <NeumorphicButton variant="ghost" className={styles.item} role="menuitem" onClick={onShowLineCommit}
          disabled={!target.lineRequest}>
          <span>Show line commit</span>
          <GitCommitHorizontal aria-hidden="true" />
        </NeumorphicButton>
        <NeumorphicButton variant="ghost" className={styles.item} role="menuitem" onClick={onExplain}
          disabled={!target.selection && !target.error}>
          <span>Explain code</span>
          <BookOpen aria-hidden="true" />
        </NeumorphicButton>
      </LiquidGlassPanel>
    </div>,
    document.body,
  );
}
