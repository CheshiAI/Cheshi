import { useRef, useState } from 'react';

import { SidebarRailButton, StatusToast, WorkspaceProjectIcon } from '../../shared/ui';
import { cheshiDesktop as workspace } from '../../cheshiDesktop';
import { workspaceError } from './workspace-management/workspace-paths';

const workspaceName = workspace?.workspaceName ?? 'Workspace';
const workspaceRoot = workspace?.workspaceRoot ?? 'Workspace root unavailable';

export function WorkspaceSelector() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const api = workspace?.workspaceManagement;

  const openManager = async (): Promise<void> => {
    if (!api || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try { await api.openManager(); }
    catch (cause) { setError(workspaceError(cause)); }
    finally { pending.current = false; setBusy(false); }
  };

  return <>
    <SidebarRailButton icon={<WorkspaceProjectIcon name={workspaceName} rootPath={workspaceRoot} />}
      iconSize="project" label={workspaceName} aria-label={`Manage workspaces — ${workspaceName}`}
      aria-busy={busy} disabled={busy || !api} onClick={() => void openManager()} />
    {error && <StatusToast message={{ id: 1, variant: 'error', title: 'Could not open workspace manager', description: error }}
      onDismiss={() => setError(null)} />}
  </>;
}
