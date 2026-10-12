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
  let localSnapshot: GitRepositorySnapshot;
  try {
    localSnapshot = await desktop.getGitSnapshot();
  } catch (error) {
    return { snapshot: null, error: `Local refresh failed: ${errorMessage(error)}` };
  }
  if (localSnapshot.available !== true) return { snapshot: localSnapshot, error: null };

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
