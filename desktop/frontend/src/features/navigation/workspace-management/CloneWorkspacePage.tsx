import { useRef, useState } from 'react';
import { FolderOpen, GitFork } from 'lucide-react';
import type { WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { LoadingState, NeumorphicButton, NeumorphicCheckbox, NeumorphicTextField, SearchClearButton } from '../../../shared/ui';
import { WorkspaceManagerHeader } from './WorkspaceManagerHeader';
import managerStyles from './WorkspaceManager.module.css';
import { GitHubRepositoryPicker } from './GitHubRepositoryPicker';
import type { GitHubRepositoryCatalog } from './github-repository-catalog';
import { useWorkspaceOperation } from './useWorkspaceOperation';
import { childDirectory, parentDirectory, repositoryDirectoryName, validDirectoryName, workspaceError } from './workspace-paths';
import styles from './workspace-management.module.css';

export function CloneWorkspaceProgress({ opening, onBack }: { opening: boolean; onBack: () => void }) {
  return <>
    <WorkspaceManagerHeader title="Clone repository" icon={<GitFork />} busy onBack={onBack} />
    <main className={`${managerStyles.page} ${styles.preparingPage}`} aria-label="Clone repository progress">
      <div className={styles.cloneProgress}>
        <LoadingState type={opening ? 'preparing' : 'processing'} />
        <p className={styles.hint} role="status">{opening
          ? 'Repository cloned. Opening workspace…'
          : 'Cloning repository… This may take a few minutes.'}</p>
      </div>
    </main>
  </>;
}

export function CloneWorkspacePage({ api, currentPath, onClose, initialCatalog, initialSource = 'github' }: {
  api: WorkspaceManagementApi; currentPath: string; onClose: () => void;
  initialCatalog: GitHubRepositoryCatalog | null;
  initialSource?: 'github' | 'url';
}) {
  const [url, setUrl] = useState('');
  const [source, setSource] = useState(initialSource);
  const [githubRepository, setGitHubRepository] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState(parentDirectory(currentPath));
  const [directoryName, setDirectoryName] = useState('');
  const [shallow, setShallow] = useState(false);
  const [depth, setDepth] = useState('1');
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const customName = useRef(false);
  const urlInput = useRef<HTMLInputElement | null>(null);
  const parentInput = useRef<HTMLInputElement | null>(null);
  const directoryInput = useRef<HTMLInputElement | null>(null);
  const choosingRef = useRef(false);
  const operation = useWorkspaceOperation(api, onClose);
  const busy = operation.busy || choosing;
  const valid = url.trim() && parentPath.trim() && validDirectoryName(directoryName)
    && (!shallow || (/^\d+$/.test(depth) && Number.isSafeInteger(Number(depth)) && Number(depth) > 0 && Number(depth) <= 1_000_000));
  const changeUrl = (value: string): void => {
    setUrl(value);
    setGitHubRepository(null);
    if (!customName.current) setDirectoryName(repositoryDirectoryName(value));
  };
  const changeDirectoryName = (value: string): void => {
    customName.current = true;
    setDirectoryName(value);
  };
  const choose = async (): Promise<void> => {
    if (choosingRef.current) return;
    choosingRef.current = true;
    setChoosing(true); setChooseError(null);
    try { const path = await api.chooseDirectory(); if (path) setParentPath(path); }
    catch (error) { setChooseError(workspaceError(error)); }
    finally { choosingRef.current = false; setChoosing(false); }
  };
  if (operation.busy) return <CloneWorkspaceProgress opening={operation.created !== null} onBack={onClose} />;

  return <>
    <WorkspaceManagerHeader title="Clone repository" icon={<GitFork />} busy={busy} onBack={onClose} />
    <main className={managerStyles.page} aria-label="Clone repository">
      <form className={styles.form} onSubmit={(event) => {
        event.preventDefault();
        if (!busy && (valid || operation.created)) void operation.run(() => api.clone({
          url: url.trim(), parentPath: parentPath.trim(), directoryName: directoryName.trim(),
          ...(githubRepository ? { githubRepository } : {}),
          ...(shallow ? { depth: Number(depth) } : {}),
        }));
      }}>
        <fieldset disabled={busy || Boolean(operation.created)} className={styles.fields}>
          <div className={styles.sourceChoices} role="group" aria-label="Repository source">
            <NeumorphicButton raised size="standard" active={source === 'github'} aria-pressed={source === 'github'} onClick={() => setSource('github')}>GitHub repositories</NeumorphicButton>
            <NeumorphicButton raised size="standard" active={source === 'url'} aria-pressed={source === 'url'} onClick={() => setSource('url')}>Repository URL</NeumorphicButton>
          </div>
          {source === 'github' && <GitHubRepositoryPicker api={api} initialCatalog={initialCatalog} disabled={busy || Boolean(operation.created)} onSelect={(repository) => {
            setUrl(repository.cloneUrl);
            setGitHubRepository(repository.fullName);
            if (!customName.current) setDirectoryName(repositoryDirectoryName(repository.cloneUrl));
            setSource('url');
          }} />}
          {source === 'url' && <>
          <label><span className={styles.fieldLabel}>Repository URL</span><NeumorphicTextField ref={urlInput} autoFocus required value={url} placeholder="https://github.com/owner/project.git"
            onChange={(event) => changeUrl(event.target.value)}
            trailingAction={url ? <SearchClearButton aria-label="Clear repository URL" disabled={busy || Boolean(operation.created)}
              onClick={() => { changeUrl(''); urlInput.current?.focus(); }} /> : undefined} /></label>
          <p className={styles.hint}>{githubRepository ? 'Uses your connected GitHub account.' : 'GitHub and other Git repositories over HTTPS or SSH. Uses your local Git credentials.'}</p>
          </>}
          <label><span className={styles.fieldLabel}>Parent folder</span><div className={styles.folderField}><NeumorphicTextField ref={parentInput} required value={parentPath} onChange={(event) => setParentPath(event.target.value)}
            trailingAction={parentPath ? <SearchClearButton aria-label="Clear parent folder" disabled={busy || Boolean(operation.created)}
              onClick={() => { setParentPath(''); parentInput.current?.focus(); }} /> : undefined} />
            <NeumorphicButton raised size="standard" onClick={() => void choose()} aria-label="Choose clone parent folder"><FolderOpen />Browse</NeumorphicButton></div></label>
          <label><span className={styles.fieldLabel}>Folder name</span><NeumorphicTextField ref={directoryInput} required value={directoryName} onChange={(event) => changeDirectoryName(event.target.value)}
            trailingAction={directoryName ? <SearchClearButton aria-label="Clear folder name" disabled={busy || Boolean(operation.created)}
              onClick={() => { changeDirectoryName(''); directoryInput.current?.focus(); }} /> : undefined} /></label>
        </fieldset>
        {operation.created && <p role="status" className={styles.hint}>Repository ready at {operation.created.rootPath}. Retry opening it without cloning again.</p>}
        {(operation.error || chooseError) && <p role="alert" className={styles.error}>{operation.error || chooseError}</p>}
        {choosing && <p role="status" className={styles.hint}>Choosing folder…</p>}
        <footer className={styles.splitFooter}>
          <fieldset disabled={busy || Boolean(operation.created)} className={`${styles.fields} ${styles.footerDetails}`}>
            <p className={styles.path}>{childDirectory(parentPath, directoryName)}</p>
            <div className={styles.shallow}><NeumorphicCheckbox checked={shallow} disabled={busy || Boolean(operation.created)} onChange={(event) => setShallow(event.target.checked)}><span className={styles.fieldLabel}>Shallow clone</span></NeumorphicCheckbox>
              {shallow && <label className={styles.depth}>Commits<NeumorphicTextField type="number" min="1" max="1000000" step="1" required value={depth} onChange={(event) => setDepth(event.target.value)} /></label>}</div>
          </fieldset>
          <div className={styles.footer}>
            <NeumorphicButton raised size="standard" disabled={busy} onClick={onClose}>Cancel</NeumorphicButton>
            <NeumorphicButton raised size="standard" type="submit" disabled={busy || (!valid && !operation.created)}><GitFork />{operation.created ? 'Open in new window' : 'Clone and open'}</NeumorphicButton>
          </div>
        </footer>
      </form>
    </main>
  </>;
}
