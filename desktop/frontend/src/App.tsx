import { lazy, Suspense } from 'react';
import { WorkspaceManager } from './features/navigation/workspace-management/WorkspaceManager';
import { workspaceManager } from './workspaceManager';
import { cheshiDesktop } from './cheshiDesktop';
import { WorkspaceHostShell } from './features/shell/WorkspaceHostShell';

const AppShell = lazy(() => import('./features/shell/AppShell').then(module => ({ default: module.AppShell })));
const HelpCenter = lazy(() => import('./features/help/HelpCenter').then(module => ({ default: module.HelpCenter })));

export default function App() {
  if (window.workspaceHost) return <WorkspaceHostShell api={window.workspaceHost} />;
  return <>
    {workspaceManager ? <WorkspaceManager {...workspaceManager} /> : <Suspense fallback={null}><AppShell /></Suspense>}
    <Suspense fallback={null}><HelpCenter api={workspaceManager?.api ?? cheshiDesktop?.workspaceManagement} /></Suspense>
  </>;
}
