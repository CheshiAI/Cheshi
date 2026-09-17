import { useRef, useState } from 'react';

import { NeumorphicButton, WorkspaceProjectIcon } from '../../shared/ui';
import { cheshiDesktop as workspace } from '../../cheshiDesktop';
import { presentationWorkspaceRoot } from '../../shared/presentation';
import { workspaceError } from './workspace-management/workspace-paths';
import styles from './workspace-management/workspace-management.module.css';

const workspaceName = workspace?.workspaceName ?? 'Workspace';
const workspaceRoot = workspace
  ? presentationWorkspaceRoot(workspace.workspaceRoot, workspaceName)
  : 'Workspace root unavailable';

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

  return (
    <div className="workspace-selector">
      <NeumorphicButton
        raised
        className="workspace-selector-trigger"
        aria-label={`Manage workspaces — ${workspaceName}`}
        title={api ? 'Open workspace manager in a new window' : 'Workspace management is available in the Cheshi desktop app'}
        aria-busy={busy}
        disabled={busy || !api}
        onClick={() => void openManager()}
      >
        <WorkspaceProjectIcon name={workspaceName} rootPath={workspaceRoot} />
        <span className="workspace-selector-copy">
          <span className="workspace-selector-title">
            <span className="workspace-label">Workspace</span>
            <strong className="workspace-name">{workspaceName}</strong>
          </span>
          <span className="workspace-root" title={workspaceRoot}>{workspaceRoot}</span>
        </span>
      </NeumorphicButton>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  );
}
