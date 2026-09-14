import { AppShell } from './features/shell/AppShell';
import { WorkspaceManager } from './features/navigation/workspace-management/WorkspaceManager';
import { workspaceManager } from './workspaceManager';
import { useDragSelectionCopy } from './shared/useDragSelectionCopy';

export default function App() {
  useDragSelectionCopy();
  return workspaceManager ? <WorkspaceManager {...workspaceManager} /> : <AppShell />;
}
