import type { GitHubLoginApi } from '../frontend/src/features/navigation/workspace-management/github-login';

export function createGitHubLoginApi(overrides: Partial<GitHubLoginApi> = {}): GitHubLoginApi {
  return {
    startGitHubLogin: async () => { throw new Error('Unexpected sign-in request'); },
    getGitHubLogin: async () => { throw new Error('Unexpected sign-in polling'); },
    cancelGitHubLogin: async () => {},
    openGitHubLoginBrowser: async () => { throw new Error('Unexpected browser request'); },
    ...overrides,
  };
}
