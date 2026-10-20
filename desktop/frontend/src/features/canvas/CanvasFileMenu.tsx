import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Pencil } from 'lucide-react';
import { focusAdjacentMenuItem, LiquidGlassPanel, RegionalBlur, useContextMenuInteractions } from '../../shared/ui';
import popupStyles from '../navigation/WorkspaceFileContextMenu.module.css';
import styles from './CanvasSidebar.module.css';

export function CanvasFileMenu({ x, y, onRename, onClose }: {
  x: number; y: number; onRename(): void; onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const source = useRef(document.getElementById('app'));
  useContextMenuInteractions(menu, onClose);
  return <RegionalBlur sourceRef={source}>{createPortal(
    <div ref={menu} className={`${popupStyles.anchor} ${styles.menu}`} style={{
      left: Math.max(8, Math.min(x, window.innerWidth - 168)), top: Math.max(8, Math.min(y, window.innerHeight - 64)),
    }}>
      <LiquidGlassPanel className={popupStyles.surface} role="menu" aria-label="Canvas file actions"
        onKeyDown={focusAdjacentMenuItem} onContextMenu={event => event.preventDefault()}>
        <button type="button" role="menuitem" className="liquid-glass-menu-item" onClick={onRename}>
          <span>Rename</span><Pencil aria-hidden="true" />
        </button>
      </LiquidGlassPanel>
    </div>, document.body,
  )}</RegionalBlur>;
}
