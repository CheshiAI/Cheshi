import { useEffect, useState } from 'react';
import { GitFork } from 'lucide-react';
import type { WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { LoadingState } from '../../../shared/ui';
import { GitHubSignIn } from './GitHubSignIn';
import { CloneWorkspacePage } from './CloneWorkspacePage';
import { WorkspaceManagerHeader } from './WorkspaceManagerHeader';
import managerStyles from './WorkspaceManager.module.css';
import { loadGitHubRepositoryCatalog, type GitHubRepositoryCatalog } from './github-repository-catalog';
import { workspaceError } from './workspace-paths';
import styles from './workspace-management.module.css';

export function PrepareCloneWorkspacePage({ api, currentPath, onClose }: {
  api: WorkspaceManagementApi;
  currentPath: string;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<GitHubRepositoryCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (manual) return;
    const controller = new AbortController();
    setError(null);
    void loadGitHubRepositoryCatalog(api, controller.signal).then((result) => {
      if (!controller.signal.aborted) setCatalog(result);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(workspaceError(cause));
    });
    return () => controller.abort();
  }, [api, retry, manual]);

  if (catalog || manual) return <CloneWorkspacePage api={api} currentPath={currentPath} onClose={onClose}
    initialCatalog={catalog} initialSource={manual ? 'url' : 'github'} />;

  return <>
    <WorkspaceManagerHeader title="Clone repository" icon={<GitFork />} onBack={onClose} />
    <main className={`${managerStyles.page} ${error ? '' : styles.preparingPage}`} aria-label="Prepare clone repository">
      <div className={styles.form}>
        {error ? <GitHubSignIn api={api} error={error} onManual={() => setManual(true)}
          onRetry={() => { setError(null); setRetry((value) => value + 1); }} />
          : <LoadingState type="preparing" className={styles.preparing} />}
      </div>
    </main>
  </>;
}
