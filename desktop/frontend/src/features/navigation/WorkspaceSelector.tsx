import { useEffect, useRef, useState } from 'react';

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
  const [color, setColor] = useState<string>();
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.list().then(catalog => {
      if (alive) setColor(catalog.workspaces.find(entry => entry.rootPath === workspaceRoot)?.iconColor);
    }).catch(cause => { if (alive) setError(workspaceError(cause)); });
    return () => { alive = false; };
  }, [api]);

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
    <SidebarRailButton icon={<WorkspaceProjectIcon name={workspaceName} color={color} />}
      iconSize="project" label={workspaceName} aria-label={`Manage workspaces — ${workspaceName}`}
      aria-busy={busy} disabled={busy || !api} onClick={() => void openManager()} />
    {error && <StatusToast message={{ id: 1, variant: 'error', title: 'Could not open workspace manager', description: error }}
      onDismiss={() => setError(null)} />}
  </>;
}
