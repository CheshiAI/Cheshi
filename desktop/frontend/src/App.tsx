import { AppShell } from './features/shell/AppShell';
import { WorkspaceManager } from './features/navigation/workspace-management/WorkspaceManager';
import { workspaceManager } from './workspaceManager';

export default function App() {
  return workspaceManager ? <WorkspaceManager {...workspaceManager} /> : <AppShell />;
}
