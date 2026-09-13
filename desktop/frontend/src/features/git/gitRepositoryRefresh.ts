import { errorMessage } from '../../shared/errorMessage';
import type { GitRepositorySnapshot, CheshiDesktopApi } from '../../cheshiDesktop';

type GitRepositoryReader = Pick<CheshiDesktopApi, 'fetchGitRepository' | 'getGitSnapshot'>;

export interface GitRepositoryRefreshResult {
  snapshot: GitRepositorySnapshot | null;
  error: string | null;
}

export async function refreshGitRepository(
  desktop: GitRepositoryReader,
): Promise<GitRepositoryRefreshResult> {
  let remoteError: string;
  try {
    const result = await desktop.fetchGitRepository();
    return { snapshot: result.snapshot, error: null };
  } catch (error) {
    remoteError = errorMessage(error);
  }

  try {
    return { snapshot: await desktop.getGitSnapshot(), error: remoteError };
  } catch (error) {
    return {
      snapshot: null,
      error: `${remoteError} Local refresh failed: ${errorMessage(error)}`,
    };
  }
}
