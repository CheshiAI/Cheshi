import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { WorkspaceCatalogEntry, WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { Modal, NeumorphicButton } from '../../../shared/ui';
import { workspaceError } from './workspace-paths';
import styles from './workspace-management.module.css';

type OpenTarget = 'new' | 'current';
type WorkspaceOpenApi = Pick<WorkspaceManagementApi, 'open' | 'openCurrent'>;

export async function runWorkspaceOpenChoice(
  state: { pending: boolean }, api: WorkspaceOpenApi, path: string, currentPath: string, target: OpenTarget,
): Promise<boolean> {
  if (state.pending || (target === 'current' && path === currentPath)) return false;
  state.pending = true;
  try {
    if (target === 'current') await api.openCurrent(path);
    else await api.open(path);
    return true;
  } finally { state.pending = false; }
}

export function WorkspaceOpenChoices({ entry, currentPath, busy, error, onOpen }: {
  entry: WorkspaceCatalogEntry; currentPath: string; busy: boolean; error: string | null;
  onOpen: (target: OpenTarget) => void;
}) {
  const isCurrent = entry.rootPath === currentPath;
  return <div className={styles.form} aria-busy={busy}>
    <div className={styles.repository}>
      <div><strong>{entry.name}</strong><p className={styles.path}>{entry.rootPath}</p></div>
    </div>
    <p className={styles.hint}>Choose where to open this workspace.</p>
    {isCurrent && <p className={styles.hint}>This workspace is already open in the current window.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.footer}>
      <NeumorphicButton raised size="standard" disabled={busy || isCurrent}
        title={isCurrent ? 'This workspace is already open in the current window.' : undefined}
        onClick={() => onOpen('current')}>Open in this window</NeumorphicButton>
      <NeumorphicButton raised size="standard" disabled={busy} onClick={() => onOpen('new')}>Open in new window</NeumorphicButton>
    </div>
    {busy && <p className={styles.hint} role="status">Opening workspace…</p>}
  </div>;
}

export function OpenWorkspaceDialog({ api, entry, currentPath, onClose, restoreFocus }: {
  api: WorkspaceOpenApi; entry: WorkspaceCatalogEntry; currentPath: string;
  onClose: () => void; restoreFocus: () => boolean;
}) {
  const pending = useRef({ pending: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async (target: OpenTarget): Promise<void> => {
    if (pending.current.pending || (target === 'current' && entry.rootPath === currentPath)) return;
    setBusy(true);
    setError(null);
    try {
      if (await runWorkspaceOpenChoice(pending.current, api, entry.rootPath, currentPath, target)) onClose();
    } catch (cause) { setError(workspaceError(cause)); }
    finally { setBusy(false); }
  };
  return <Modal title="Open workspace" titleIcon={<FolderOpen aria-hidden="true" />} className={styles.dialog}
    onClose={() => { if (!pending.current.pending) onClose(); }} restoreFocus={restoreFocus}>
    <WorkspaceOpenChoices entry={entry} currentPath={currentPath} busy={busy} error={error}
      onOpen={(target) => { void open(target); }} />
  </Modal>;
}
