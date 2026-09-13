import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderOpen, GitBranch } from 'lucide-react';
import type { WorkspaceManagementApi, WorkspaceWorktree } from '../../../../../shared/workspace-management';
import { LoadingState, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../../shared/ui';
import { WorkspaceManagerHeader } from './WorkspaceManagerHeader';
import managerStyles from './WorkspaceManager.module.css';
import { useWorkspaceOperation } from './useWorkspaceOperation';
import { childDirectory, parentDirectory, validDirectoryName, workspaceError } from './workspace-paths';
import styles from './workspace-management.module.css';

export function WorktreeWorkspacePage({ api, currentPath, onClose }: {
  api: WorkspaceManagementApi; currentPath: string; onClose: () => void;
}) {
  const [repositoryPath, setRepositoryPath] = useState(currentPath);
  const [worktrees, setWorktrees] = useState<WorkspaceWorktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('HEAD');
  const [directoryName, setDirectoryName] = useState('');
  const branchInput = useRef<HTMLInputElement | null>(null);
  const baseRefInput = useRef<HTMLInputElement | null>(null);
  const directoryInput = useRef<HTMLInputElement | null>(null);
  const actionRunning = useRef(false);
  const operation = useWorkspaceOperation(api, onClose);
  const busy = actionBusy || operation.busy;
  const valid = branch.trim() && baseRef.trim() && validDirectoryName(directoryName);
  const repositoryRoot = worktrees.find((entry) => entry.isCurrent)?.path ?? repositoryPath;
  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (actionRunning.current || operation.busy) return;
    actionRunning.current = true; setActionBusy(true); setActionError(null);
    try { await action(); } catch (error) { setActionError(workspaceError(error)); }
    finally { actionRunning.current = false; setActionBusy(false); }
  };
  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError(null); setWorktrees([]);
    void api.listWorktrees(repositoryPath).then((entries) => {
      if (active) setWorktrees(entries);
    }).catch((error: unknown) => { if (active) setLoadError(workspaceError(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, repositoryPath, refresh]);

  return <>
    <WorkspaceManagerHeader title="Git worktrees" icon={<GitBranch />} busy={busy} onBack={onClose} />
    <main className={`${managerStyles.page} ${loading ? styles.preparingPage : ''}`} aria-label="Git worktrees">
      {loading ? <LoadingState type="preparing" className={styles.preparing} /> :
      <div className={styles.form}>
        <div className={styles.repository}>
          <div><span className={styles.sectionLabel}>Repository</span><p className={styles.path}>{repositoryPath}</p></div>
          <NeumorphicButton raised size="standard" disabled={busy || Boolean(operation.created)} onClick={() => void runAction(async () => {
            const path = await api.chooseDirectory();
            if (path && path !== repositoryPath) { setLoading(true); setRepositoryPath(path); setBaseRef('HEAD'); }
          })}><FolderOpen />Choose repository</NeumorphicButton>
        </div>
        <section aria-label="Existing worktrees" className={styles.worktrees}>
          <h3>Existing worktrees</h3>
          {loadError && <div><p role="alert" className={styles.error}>{loadError}</p><NeumorphicButton raised size="standard" disabled={busy} onClick={() => { setLoading(true); setRefresh((value) => value + 1); }}>Retry</NeumorphicButton></div>}
          {!loading && !loadError && worktrees.length === 0 && <p className={styles.hint}>No worktrees found. Select a local Git repository.</p>}
          {worktrees.map((entry) => <div className={styles.worktree} key={entry.path}>
            <GitBranch aria-hidden="true" />
            <div><strong>{entry.branch || 'Detached HEAD'}</strong>
              {entry.isCurrent && <span className={styles.badge}>Current</span>}
              {entry.locked && <span className={styles.badge}>Locked</span>}
              {entry.prunable && <span className={styles.badge}>Unavailable</span>}
              <p className={styles.path}>{entry.path}</p></div>
            <NeumorphicButton raised size="icon" disabled={busy || entry.prunable} aria-label={`Open ${entry.branch || entry.path} in new window`}
              onClick={() => void runAction(async () => { await api.open(entry.path); onClose(); })}><ExternalLink /></NeumorphicButton>
          </div>)}
        </section>
        <form className={styles.creationForm} onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !loading && !loadError && (valid || operation.created)) void operation.run(() => api.createWorktree({
            repositoryPath, branch: branch.trim(), baseRef: baseRef.trim(), directoryName: directoryName.trim(),
          }));
        }}>
          <fieldset className={styles.fields} disabled={busy || loading || Boolean(loadError) || Boolean(operation.created)}>
            <legend>Create a worktree</legend>
            <p className={styles.hint}>Create a new branch in a sibling folder, with its own working files.</p>
            <div className={styles.columns}>
              <label><span className={styles.fieldLabel}>New branch</span><NeumorphicTextField ref={branchInput} required value={branch} placeholder="feature/my-change" onChange={(event) => setBranch(event.target.value)}
                trailingAction={branch ? <SearchClearButton aria-label="Clear new branch" onClick={() => { setBranch(''); branchInput.current?.focus(); }} /> : undefined} /></label>
              <label><span className={styles.fieldLabel}>Start from</span><NeumorphicTextField ref={baseRefInput} required value={baseRef} placeholder="HEAD" onChange={(event) => setBaseRef(event.target.value)}
                trailingAction={baseRef ? <SearchClearButton aria-label="Clear start reference" onClick={() => { setBaseRef(''); baseRefInput.current?.focus(); }} /> : undefined} /></label>
            </div>
            <label><span className={styles.fieldLabel}>Sibling folder name</span><NeumorphicTextField ref={directoryInput} required value={directoryName} placeholder="project-my-change" onChange={(event) => setDirectoryName(event.target.value)}
              trailingAction={directoryName ? <SearchClearButton aria-label="Clear sibling folder name" onClick={() => { setDirectoryName(''); directoryInput.current?.focus(); }} /> : undefined} /></label>
          </fieldset>
          {operation.created && <p role="status" className={styles.hint}>Worktree ready at {operation.created.rootPath}. Retry opening it without creating another branch.</p>}
          {(actionError || operation.error) && <p role="alert" className={styles.error}>{actionError || operation.error}</p>}
          {busy && <p role="status" className={styles.hint}>{operation.busy && !operation.created ? 'Creating worktree…' : 'Opening workspace…'}</p>}
          <footer className={styles.splitFooter}>
            <p className={`${styles.path} ${styles.footerDetails}`}>{childDirectory(parentDirectory(repositoryRoot), directoryName.trim())}</p>
            <div className={styles.footer}>
              <NeumorphicButton raised size="standard" disabled={busy} onClick={onClose}>Cancel</NeumorphicButton>
              <NeumorphicButton raised size="standard" type="submit" disabled={busy || loading || Boolean(loadError) || (!valid && !operation.created)}><GitBranch />{operation.created ? 'Open in new window' : 'Create and open'}</NeumorphicButton>
            </div>
          </footer>
        </form>
      </div>}
    </main>
  </>;
}
