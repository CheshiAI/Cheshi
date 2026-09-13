import { useEffect, useState } from 'react';
import { GitFork, LockKeyhole, RefreshCw } from 'lucide-react';
import type { GitHubRepository, WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { LiquidGlassPanel, LoadingState, NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../../shared/ui';
import { workspaceError } from './workspace-paths';
import { GitHubSignIn } from './GitHubSignIn';
import type { GitHubLoginApi } from './github-login';
import styles from './GitHubRepositoryPicker.module.css';
import { loadGitHubRepositoryCatalog, type GitHubRepositoryCatalog } from './github-repository-catalog';
export { mergeGitHubRepositories } from './github-repository-catalog';

export function filterGitHubRepositories(repositories: GitHubRepository[], query: string): GitHubRepository[] {
  const search = query.trim().toLocaleLowerCase();
  return repositories.filter((repository) => `${repository.fullName}\n${repository.description ?? ''}`.toLocaleLowerCase().includes(search));
}

export function GitHubRepositoryResults({ repositories, disabled, onSelect }: {
  repositories: GitHubRepository[];
  disabled: boolean;
  onSelect: (repository: GitHubRepository) => void;
}) {
  return <ul className={styles.results} aria-label="GitHub repositories">
    {repositories.map((repository) => <li key={repository.id}>
      <NeumorphicButton className={styles.repository} disabled={disabled} onClick={() => onSelect(repository)}
        aria-label={`Select ${repository.fullName}${repository.private ? ' — private' : ''}`}>
        {repository.private ? <LockKeyhole aria-hidden="true" /> : <GitFork aria-hidden="true" />}
        <span><strong>{repository.fullName}</strong>{repository.description && <small>{repository.description}</small>}</span>
      </NeumorphicButton>
    </li>)}
  </ul>;
}

export function GitHubRepositoryPicker({ api, disabled, onSelect, initialCatalog }: {
  api: Pick<WorkspaceManagementApi, 'listGitHubRepositories'> & GitHubLoginApi;
  disabled: boolean;
  onSelect: (repository: GitHubRepository) => void;
  initialCatalog: GitHubRepositoryCatalog | null;
}) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(initialCatalog === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (refresh === 0 && initialCatalog) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCatalog(null);
    void loadGitHubRepositoryCatalog(api, controller.signal).then((result) => {
      if (!controller.signal.aborted) setCatalog(result);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(workspaceError(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, initialCatalog, refresh]);

  const matches = filterGitHubRepositories(catalog?.repositories ?? [], query);
  return <LiquidGlassPanel as="section" className={styles.picker} aria-label="Choose a GitHub repository" aria-busy={loading}>
    <div className={styles.heading}>
      <span>{catalog ? `Signed in as ${catalog.login}` : 'GitHub repositories'}</span>
      <NeumorphicButton raised size="icon" disabled={disabled || loading} aria-label="Refresh GitHub repositories" onClick={() => setRefresh((value) => value + 1)}>
        <RefreshCw aria-hidden="true" />
      </NeumorphicButton>
    </div>
    {loading ? <LoadingState type="preparing" className={styles.loading} /> : <>
      <NeumorphicTextField type="search" aria-label="Search GitHub repositories" placeholder="Search repositories"
        value={query} disabled={disabled} onChange={(event) => setQuery(event.target.value)}
        trailingAction={query ? <SearchClearButton aria-label="Clear repository search" disabled={disabled} onClick={() => setQuery('')} /> : undefined} />
      <GitHubRepositoryResults repositories={matches} disabled={disabled} onSelect={onSelect} />
      {!error && matches.length === 0 && <p className={styles.hint} role="status">
        {query ? 'No matching repositories.' : 'No repositories are available to this GitHub account.'}
      </p>}
      {error && <GitHubSignIn api={api} error={error} disabled={disabled} onRetry={() => setRefresh((value) => value + 1)} />}
    </>}
  </LiquidGlassPanel>;
}
