import { describe, expect, mock, test } from 'bun:test';

import { refreshGitRepository } from '../frontend/src/features/git/gitRepositoryRefresh';
import type { GitRepositorySnapshot } from '../frontend/src/cheshiDesktop';

const localSnapshot: GitRepositorySnapshot = {
  available: true,
  message: '',
  head: 'feature/example',
  behind: 0,
};

const fetchedSnapshot: GitRepositorySnapshot = {
  ...localSnapshot,
  behind: 2,
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Git repository refresh', () => {
  test('uses the local snapshot returned after fetching remote changes', async () => {
    const getGitSnapshot = mock(async () => localSnapshot);
    const result = await refreshGitRepository({
      fetchGitRepository: async () => ({ output: '', snapshot: fetchedSnapshot }),
      getGitSnapshot,
    });

    expect(result).toEqual({ snapshot: fetchedSnapshot, error: null });
    expect(getGitSnapshot).not.toHaveBeenCalled();
  });

  test('waits for the fetch result instead of returning an older local snapshot', async () => {
    const remote = createDeferred<void>();
    const getGitSnapshot = mock(async () => localSnapshot);
    let completed = false;
    const refresh = refreshGitRepository({
      fetchGitRepository: async () => {
        await remote.promise;
        return { output: '', snapshot: fetchedSnapshot };
      },
      getGitSnapshot,
    }).then((result) => {
      completed = true;
      return result;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(getGitSnapshot).not.toHaveBeenCalled();

    remote.resolve();
    expect(await refresh).toEqual({ snapshot: fetchedSnapshot, error: null });
  });

  test('refreshes local changes and preserves the remote error when fetching fails', async () => {
    const getGitSnapshot = mock(async () => localSnapshot);
    const result = await refreshGitRepository({
      fetchGitRepository: async () => {
        throw new Error('Could not reach origin.');
      },
      getGitSnapshot,
    });

    expect(result).toEqual({ snapshot: localSnapshot, error: 'Could not reach origin.' });
    expect(getGitSnapshot).toHaveBeenCalledTimes(1);
  });

  test('returns an unavailable local repository after a failed fetch', async () => {
    const snapshot: GitRepositorySnapshot = {
      available: false,
      message: 'The workspace is not a Git worktree.',
    };
    const result = await refreshGitRepository({
      fetchGitRepository: async () => {
        throw new Error('Not a Git repository.');
      },
      getGitSnapshot: async () => snapshot,
    });

    expect(result).toEqual({ snapshot, error: 'Not a Git repository.' });
  });

  test('reports both failures without providing a replacement snapshot', async () => {
    const result = await refreshGitRepository({
      fetchGitRepository: async () => {
        throw new Error('Could not reach origin.');
      },
      getGitSnapshot: async () => {
        throw new Error('Workspace is unavailable.');
      },
    });

    expect(result).toEqual({
      snapshot: null,
      error: 'Could not reach origin. Local refresh failed: Workspace is unavailable.',
    });
  });
});
