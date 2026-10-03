import { AppShell } from './features/shell/AppShell';
import { WorkspaceManager } from './features/navigation/workspace-management/WorkspaceManager';
import { workspaceManager } from './workspaceManager';
import { cheshiDesktop } from './cheshiDesktop';
import { HelpCenter } from './features/help/HelpCenter';

export default function App() {
  return <>
    {workspaceManager ? <WorkspaceManager {...workspaceManager} /> : <AppShell />}
    <HelpCenter api={workspaceManager?.api ?? cheshiDesktop?.workspaceManagement} />
  </>;
}
