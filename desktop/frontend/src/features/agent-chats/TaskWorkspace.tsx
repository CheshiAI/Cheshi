import { useEffect, useRef, useState } from 'react';
import { Copy, FolderOpen, GitBranch, RefreshCw } from 'lucide-react';
import type { ChatsRequest, RoomMessage } from '../../../../shared/agent-chats';
import { workerWorkspaceTarget } from '../../../../shared/worker-workspace';
import { ContentCard, NeumorphicButton } from '../../shared/ui';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import styles from './TaskWorkspace.module.css';

export function TaskWorkspace({ message, owner, mutate }: {
  message: RoomMessage; owner: string; mutate(request: ChatsRequest): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false), alive = useRef(true);
  const scrollbar = useAutoHideScrollbars<HTMLPreElement>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const workspace = message.workspaceInspection, target = workerWorkspaceTarget(message);
  async function inspect(action: 'workspace-inspect' | 'workspace-open') {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await mutate({ action, roomId: message.roomId, messageId: message.id }); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Could not inspect the worktree.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function copyPath() {
    if (!workspace?.workspace) return;
    try { await navigator.clipboard.writeText(workspace.workspace); if (alive.current) setNotice('Path copied.'); }
    catch { if (alive.current) setError('Could not copy the path.'); }
  }
  return <ContentCard as="section" className={styles.panel} aria-label={`Worktree for ${owner}`}
    collapsible descriptionWhenCollapsed icon={<GitBranch aria-hidden="true" />} title="Worktree"
    description={workspace?.branch ?? owner}
    status={busy ? 'Inspecting…' : error ? 'Unavailable' : workspace?.state === 'ready' ? 'Ready'
      : workspace?.state === 'missing' ? 'Missing' : workspace?.state === 'unavailable' ? 'Unavailable' : undefined}
    bodyClassName={styles.body} onExpandedChange={open => {
      setExpanded(open); if (open) void inspect('workspace-inspect');
    }}>
    {expanded && <>
      <dl className={styles.facts}>
        <dt>Homie</dt><dd>{owner}</dd>
        <dt>Task</dt><dd>{target?.taskId}</dd>
        {workspace?.workspace && <><dt>Path</dt><dd>{workspace.workspace}</dd></>}
        {workspace?.branch && <><dt>{workspace.state === 'ready' ? 'Branch' : 'Recorded branch'}</dt><dd>{workspace.branch}</dd></>}
        {workspace?.baseCommit && <>
          <dt>Starting branch</dt><dd>{workspace.baseBranch?.replace(/^refs\/heads\//, '') ?? 'Not recorded'}</dd>
          <dt>Starting commit</dt><dd>{workspace.baseCommit}</dd>
          <dt>Workspace</dt><dd>{workspace.kind === 'intake' ? 'Read-only intake' : workspace.kind === 'legacy' ? 'Retained legacy workspace' : 'Task worktree'}</dd>
        </>}
      </dl>
      <div className={styles.actions}>
        <NeumorphicButton variant="ghost" disabled={busy} onClick={() => void inspect('workspace-inspect')}><RefreshCw aria-hidden="true" />Refresh worktree</NeumorphicButton>
        <NeumorphicButton variant="ghost" disabled={!workspace?.workspace} onClick={() => void copyPath()}><Copy aria-hidden="true" />Copy path</NeumorphicButton>
        <NeumorphicButton variant="ghost" disabled={busy || workspace?.state !== 'ready'} onClick={() => void inspect('workspace-open')}><FolderOpen aria-hidden="true" />Open folder</NeumorphicButton>
      </div>
      {busy && <p role="status">Inspecting worktree…</p>}
      {(error || workspace?.error) && <p role="status">{error || workspace?.error}</p>}
      {notice && <p role="status">{notice}</p>}
      {workspace?.state === 'ready' && <>
        <p>Changes compared with the starting commit · Checked {new Date(workspace.checkedAt).toLocaleTimeString()}</p>
        {workspace.changes.length ? <details><summary>Changed files ({workspace.changes.length}{workspace.truncated ? '+' : ''})</summary>
          <ul>{workspace.changes.map(change => <li key={change.path}><code>{change.status}</code> {change.path}</li>)}</ul>
          <pre ref={scrollbar} className={styles.diff}>{workspace.diff || 'No text diff available.'}</pre>
        </details> : <p>No changed files.</p>}
        {workspace.truncated && <p>Results are shortened. Open the folder to inspect all changes.</p>}
      </>}
    </>}
  </ContentCard>;
}
