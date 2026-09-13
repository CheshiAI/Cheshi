import type { GitHubRepository, WorkspaceManagementApi } from '../../../../../shared/workspace-management';

export interface GitHubRepositoryCatalog {
  login: string;
  repositories: GitHubRepository[];
}

export function mergeGitHubRepositories(current: GitHubRepository[], incoming: GitHubRepository[]): GitHubRepository[] {
  const merged = new Map(current.map((repository) => [repository.id, repository]));
  for (const repository of incoming) merged.set(repository.id, repository);
  return [...merged.values()];
}

/** Publish one complete catalog, never a partially fetched page. */
export async function loadGitHubRepositoryCatalog(
  api: Pick<WorkspaceManagementApi, 'listGitHubRepositories'>,
  signal: AbortSignal,
): Promise<GitHubRepositoryCatalog> {
  let page = 1;
  let login: string | null = null;
  let repositories: GitHubRepository[] = [];
  while (true) {
    signal.throwIfAborted();
    const result = await api.listGitHubRepositories(page);
    signal.throwIfAborted();
    if (login !== null && login !== result.login) {
      throw new Error('The GitHub account changed. Retry loading repositories.');
    }
    login = result.login;
    repositories = mergeGitHubRepositories(repositories, result.repositories);
    if (result.nextPage === null) return { login, repositories };
    if (!Number.isSafeInteger(result.nextPage) || result.nextPage <= page) {
      throw new Error('GitHub returned an invalid repository page. Retry loading repositories.');
    }
    page = result.nextPage;
  }
}
