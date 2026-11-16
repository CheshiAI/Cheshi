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
    expect(getGitSnapshot).toHaveBeenCalledTimes(1);
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
    expect(getGitSnapshot).toHaveBeenCalledTimes(1);

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
    expect(getGitSnapshot).toHaveBeenCalledTimes(2);
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
      getGitSnapshot: mock(async () => localSnapshot).mockImplementationOnce(async () => localSnapshot)
        .mockImplementation(async () => snapshot),
    });

    expect(result).toEqual({ snapshot, error: 'Not a Git repository.' });
  });

  test('reports both failures without providing a replacement snapshot', async () => {
    const result = await refreshGitRepository({
      fetchGitRepository: async () => {
        throw new Error('Could not reach origin.');
      },
      getGitSnapshot: mock(async (): Promise<GitRepositorySnapshot> => {
        throw new Error('Workspace is unavailable.');
      }).mockImplementationOnce(async () => localSnapshot),
    });

    expect(result).toEqual({
      snapshot: null,
      error: 'Could not reach origin. Local refresh failed: Workspace is unavailable.',
    });
  });

  test('skips fetching a non-Git folder on every refresh and retains its unavailable message', async () => {
    const snapshot: GitRepositorySnapshot = { available: false, message: 'The workspace is not a Git worktree.' };
    const fetchGitRepository = mock(async () => ({ output: '', snapshot: fetchedSnapshot }));
    const getGitSnapshot = mock(async () => snapshot);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await refreshGitRepository({ fetchGitRepository, getGitSnapshot })).toEqual({ snapshot, error: null });
    }
    expect(fetchGitRepository).not.toHaveBeenCalled();
    expect(getGitSnapshot).toHaveBeenCalledTimes(3);
  });

  test('does not fetch until the local repository check succeeds', async () => {
    const local = createDeferred<GitRepositorySnapshot>();
    const fetchGitRepository = mock(async () => ({ output: '', snapshot: fetchedSnapshot }));
    const refresh = refreshGitRepository({ fetchGitRepository, getGitSnapshot: () => local.promise });
    await Promise.resolve();
    expect(fetchGitRepository).not.toHaveBeenCalled();
    local.resolve(localSnapshot);
    expect(await refresh).toEqual({ snapshot: fetchedSnapshot, error: null });
    expect(fetchGitRepository).toHaveBeenCalledTimes(1);
  });

  test('rechecks availability so a newly initialized repository can resume fetching', async () => {
    let snapshot: GitRepositorySnapshot = { available: false, message: 'Not a Git repository.' };
    const fetchGitRepository = mock(async () => ({ output: '', snapshot: fetchedSnapshot }));
    const api = { fetchGitRepository, getGitSnapshot: async () => snapshot };
    expect(await refreshGitRepository(api)).toEqual({ snapshot, error: null });
    expect(fetchGitRepository).not.toHaveBeenCalled();
    snapshot = localSnapshot;
    expect(await refreshGitRepository(api)).toEqual({ snapshot: fetchedSnapshot, error: null });
    expect(fetchGitRepository).toHaveBeenCalledTimes(1);
  });

  test('reports a local check failure without attempting a remote fetch', async () => {
    const fetchGitRepository = mock(async () => ({ output: '', snapshot: fetchedSnapshot }));
    const result = await refreshGitRepository({ fetchGitRepository, getGitSnapshot: async () => {
      throw new Error('Workspace is unavailable.');
    } });
    expect(result).toEqual({ snapshot: null, error: 'Local refresh failed: Workspace is unavailable.' });
    expect(fetchGitRepository).not.toHaveBeenCalled();
  });

  test.each([undefined, null, 'true', 1])('does not accept a malformed availability flag: %s', async (available: unknown) => {
    const fetchGitRepository = mock(async () => ({ output: '', snapshot: fetchedSnapshot }));
    await refreshGitRepository({ fetchGitRepository,
      getGitSnapshot: async () => ({ ...localSnapshot, available } as GitRepositorySnapshot) });
    expect(fetchGitRepository).not.toHaveBeenCalled();
  });
});
