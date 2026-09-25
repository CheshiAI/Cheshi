import { Columns2, GripVertical, Maximize2, Minimize2, Rows2 } from 'lucide-react';
import { createContext, useContext } from 'react';
import { NeumorphicButton } from '../../shared/ui/NeumorphicButton';
import type { SplitPreviewDirection } from '../../shared/ui/SplitPreview';
import type { WorkspacePaneId } from './workspaceLayoutModel';
import styles from './WorkspaceLayoutControls.module.css';

export const WorkspaceLayoutContext = createContext<{
  split(target: WorkspacePaneId, direction: SplitPreviewDirection): void;
  startDrag(paneId: WorkspacePaneId): void;
  maximize(paneId: WorkspacePaneId): void;
  canMaximize: boolean;
  maximized: WorkspacePaneId | null;
} | null>(null);
export const WorkspacePaneContext = createContext<WorkspacePaneId>('primary');
export const WorkspacePaneVisibilityContext = createContext(true);
export const workspacePaneDragType = 'application/x-cheshi-workspace-pane';
function WorkspacePaneDragHandle() {
  const controls = useContext(WorkspaceLayoutContext);
  const pane = useContext(WorkspacePaneContext);
  if (!controls) return null;
  return <NeumorphicButton size="icon" draggable className={styles.dragHandle}
    aria-label="Move workspace pane" title="Drag to a pane's left, right, top or bottom edge"
    onDragStart={event => {
      event.dataTransfer.setData(workspacePaneDragType, pane);
      event.dataTransfer.effectAllowed = 'move';
      controls.startDrag(pane);
    }}><GripVertical aria-hidden="true" /></NeumorphicButton>;
}

export function WorkspaceLayoutControls() {
  const controls = useContext(WorkspaceLayoutContext);
  const pane = useContext(WorkspacePaneContext);
  if (!controls) return null;
  const maximized = controls.maximized === pane;
  return <div className={styles.actions} role="group" aria-label="Pane layout">
    <WorkspacePaneDragHandle />
    <NeumorphicButton size="icon" aria-label="Split area right" title="Split this area right" aria-haspopup="dialog"
      onClick={() => controls.split(pane, 'right')}><Columns2 aria-hidden="true" /></NeumorphicButton>
    <NeumorphicButton size="icon" aria-label="Split area down" title="Split this area down" aria-haspopup="dialog"
      onClick={() => controls.split(pane, 'down')}><Rows2 aria-hidden="true" /></NeumorphicButton>
    <NeumorphicButton size="icon" aria-label={maximized ? 'Restore pane size' : 'Maximize pane'}
      title={maximized ? 'Restore pane size' : 'Maximize pane'} disabled={!controls.canMaximize}
      onClick={() => controls.maximize(pane)}>
      {maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
    </NeumorphicButton>
  </div>;
}
