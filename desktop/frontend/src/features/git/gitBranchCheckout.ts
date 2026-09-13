import { isLiteralTrue } from '../../shared/isLiteralTrue.ts';
import type { GitRepositorySnapshot, CheshiDesktopApi } from '../../cheshiDesktop';

type GitBranchCheckoutApi = Pick<CheshiDesktopApi, 'getGitSnapshot' | 'checkoutGitBranch'>;

export async function checkoutGitBranch(
  desktop: GitBranchCheckoutApi,
  branchName: string,
): Promise<GitRepositorySnapshot> {
  const snapshot = await desktop.getGitSnapshot();
  if (!isLiteralTrue(snapshot.available)) {
    throw new Error(snapshot.message || 'Git repository is unavailable.');
  }
  if (!Array.isArray(snapshot.changes)) {
    throw new Error('Could not check local changes. Refresh and try again.');
  }
  if (snapshot.changes.length > 0) {
    throw new Error('Commit or discard local changes before switching branches.');
  }
  return desktop.checkoutGitBranch(branchName);
}
