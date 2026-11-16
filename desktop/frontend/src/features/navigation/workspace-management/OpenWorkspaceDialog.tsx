import { useRef, useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import type { WorkspaceCatalogEntry, WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { Modal, NeumorphicButton } from '../../../shared/ui';
import { isLiteralTrue } from '../../../shared/isLiteralTrue';
import { workspaceError } from './workspace-paths';
import styles from './OpenWorkspaceDialog.module.css';

type OpenTarget = 'new' | 'current';
type WorkspaceOpenApi = Pick<WorkspaceManagementApi, 'open' | 'openCurrent'>;

function canReplaceWorkspace(path: string, currentPath: string): boolean {
  return currentPath.length > 0 && path !== currentPath;
}

export async function runWorkspaceOpenChoice(
  state: { pending: boolean }, api: WorkspaceOpenApi, path: string, currentPath: string, target: OpenTarget,
): Promise<boolean> {
  if (state.pending || (target === 'current' && !canReplaceWorkspace(path, currentPath))) return false;
  state.pending = true;
  try {
    if (target === 'current') await api.openCurrent(path);
    else await api.open(path);
    return true;
  } finally { state.pending = false; }
}

export function WorkspaceOpenChoices({ entry, currentPath, busy, error, onOpen, busyLabel = 'Opening workspace…' }: {
  entry: WorkspaceCatalogEntry; currentPath: string; busy: boolean; error: string | null;
  onOpen: (target: OpenTarget) => void;
  busyLabel?: string;
}) {
  const isCurrent = entry.rootPath === currentPath;
  return <div className={styles.form} aria-busy={busy}>
    <div className={styles.repository}>
      <strong>{entry.name}</strong>
      <p className={styles.description}>{entry.rootPath}</p>
    </div>
    <p className={styles.description}>Choose where to open this workspace.</p>
    {isCurrent && <p className={styles.description}>This workspace is already open in the current window.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.footer}>
      {currentPath.length > 0 && <NeumorphicButton variant="standard" disabled={busy || !canReplaceWorkspace(entry.rootPath, currentPath)}
        title={isCurrent ? 'This workspace is already open in the current window.' : undefined}
        onClick={() => onOpen('current')}>Open in this window</NeumorphicButton>}
      <NeumorphicButton variant="standard" disabled={busy} onClick={() => onOpen('new')}>Open in new window</NeumorphicButton>
    </div>
    {busy && <p className={styles.description} role="status">{busyLabel}</p>}
  </div>;
}

export function OpenWorkspaceDialog({ api, entry, currentPath, onClose, onDeleted, restoreFocus }: {
  api: WorkspaceOpenApi & Pick<WorkspaceManagementApi, 'deleteWorkspace'>; entry: WorkspaceCatalogEntry; currentPath: string;
  onClose: () => void; onDeleted: () => void; restoreFocus: () => boolean;
}) {
  const pending = useRef({ pending: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState('Opening workspace…');
  const open = async (target: OpenTarget): Promise<void> => {
    if (pending.current.pending || (target === 'current' && !canReplaceWorkspace(entry.rootPath, currentPath))) return;
    setBusy(true);
    setBusyLabel('Opening workspace…');
    setError(null);
    try {
      if (await runWorkspaceOpenChoice(pending.current, api, entry.rootPath, currentPath, target)) onClose();
    } catch (cause) { setError(workspaceError(cause)); }
    finally { setBusy(false); }
  };
  const trash = async () => {
    if (pending.current.pending) return;
    pending.current.pending = true;
    setBusy(true); setError(null); setBusyLabel('Waiting for folder deletion confirmation…');
    try {
      if (isLiteralTrue(await api.deleteWorkspace(entry.id))) onDeleted();
    } catch (cause) { setError(workspaceError(cause)); }
    finally { pending.current.pending = false; setBusy(false); }
  };
  return <Modal title="WORKSPACE OPTIONS" headerVariant="section" closeButtonVariant="ghost" closeDisabled={busy}
    titleIcon={<FolderOpen aria-hidden="true" />} className={styles.dialog}
    onClose={() => { if (!pending.current.pending) onClose(); }} restoreFocus={restoreFocus}>
    <WorkspaceOpenChoices entry={entry} currentPath={currentPath} busy={busy} error={error}
      busyLabel={busyLabel} onOpen={(target) => { void open(target); }} />
    <section className={styles.folderActions} aria-label="Folder actions">
      <p className={styles.description}>Moves the entire folder and its CodeGraph index to Trash, including uncommitted files. Chat history is kept.</p>
      <NeumorphicButton variant="ghost" disabled={busy} onClick={() => { void trash(); }}>
        <Trash2 aria-hidden="true" />Move folder to Trash…
      </NeumorphicButton>
    </section>
  </Modal>;
}
