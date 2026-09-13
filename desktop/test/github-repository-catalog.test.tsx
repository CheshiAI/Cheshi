import { describe, expect, test } from 'bun:test';
import { loadGitHubRepositoryCatalog } from '../frontend/src/features/navigation/workspace-management/github-repository-catalog';
import type { GitHubRepository, GitHubRepositoryPage, WorkspaceManagementApi } from '../shared/workspace-management';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try { await operation; }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected the operation to reject.');
}

function repository(id: number, description: string | null = null): GitHubRepository {
  return { id, fullName: `owner/project-${id}`, description, private: true, cloneUrl: `https://github.com/owner/project-${id}.git` };
}

function page(repositories: GitHubRepository[], nextPage: number | null = null, login = 'owner'): GitHubRepositoryPage {
  return { repositories, nextPage, login };
}

function load(listGitHubRepositories: WorkspaceManagementApi['listGitHubRepositories'], signal = new AbortController().signal) {
  return loadGitHubRepositoryCatalog({ listGitHubRepositories }, signal);
}

describe('complete GitHub repository catalog', () => {
  test('collects every page and replaces duplicate ids with the latest metadata', async () => {
    const calls: number[] = [];
    const pages = [page([repository(1, 'old')], 2), page([repository(2)], 3), page([repository(1, 'updated'), repository(3)])];
    const catalog = await load(async (requestedPage = 1) => {
      calls.push(requestedPage);
      return pages[requestedPage - 1]!;
    });
    expect(calls).toEqual([1, 2, 3]);
    expect(catalog).toEqual({ login: 'owner', repositories: [repository(1, 'updated'), repository(2), repository(3)] });
  });

  test('keeps the catalog pending while the final page is still loading', async () => {
    const secondPage = createDeferred<GitHubRepositoryPage>();
    const secondRequested = createDeferred<void>();
    let published = false;
    const operation = load(async (requestedPage = 1) => {
      if (requestedPage === 1) return page([repository(1)], 2);
      secondRequested.resolve();
      return secondPage.promise;
    }).then((catalog) => { published = true; return catalog; });
    await secondRequested.promise;
    expect(published).toBe(false);
    secondPage.resolve(page([repository(2)]));
    expect(await operation).toEqual({ login: 'owner', repositories: [repository(1), repository(2)] });
    expect(published).toBe(true);
  });

  test('returns a complete empty catalog for an account without repositories', async () => {
    expect(await load(async () => page([]))).toEqual({ login: 'owner', repositories: [] });
  });

  test('rejects a failed later page without publishing the earlier results', async () => {
    const failure = new Error('GitHub is unavailable');
    const calls: number[] = [];
    let published = false;
    const operation = load(async (requestedPage = 1) => {
      calls.push(requestedPage);
      if (requestedPage === 1) return page([repository(1)], 2);
      throw failure;
    }).then((catalog) => { published = true; return catalog; });
    expect(await rejectedError(operation)).toBe(failure);
    expect(calls).toEqual([1, 2]);
    expect(published).toBe(false);
  });

  test('rejects an account change between pages', async () => {
    const calls: number[] = [];
    const failure = await rejectedError(load(async (requestedPage = 1) => {
      calls.push(requestedPage);
      return requestedPage === 1 ? page([repository(1)], 2) : page([repository(2)], 3, 'another-owner');
    }));
    expect(failure.message).toContain('account changed');
    expect(calls).toEqual([1, 2]);
  });

  test.each([0, -1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid next-page value %s before making another request', async (nextPage: number) => {
      let calls = 0;
      const failure = await rejectedError(load(async () => { calls += 1; return page([repository(1)], nextPage); }));
      expect(failure.message).toContain('invalid repository page');
      expect(calls).toBe(1);
    },
  );

  test('rejects pagination moving backwards after a successful first page', async () => {
    const calls: number[] = [];
    const failure = await rejectedError(load(async (requestedPage = 1) => {
      calls.push(requestedPage);
      return page([repository(requestedPage)], requestedPage === 1 ? 2 : 1);
    }));
    expect(failure.message).toContain('invalid repository page');
    expect(calls).toEqual([1, 2]);
  });

  test('does not request any page when already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('Dialog closed');
    controller.abort(reason);
    let calls = 0;
    const failure = await rejectedError(load(async () => { calls += 1; return page([]); }, controller.signal));
    expect(failure).toBe(reason);
    expect(calls).toBe(0);
  });

  test('discards an in-flight response after abort and does not request another page', async () => {
    const controller = new AbortController();
    const pendingPage = createDeferred<GitHubRepositoryPage>();
    const reason = new Error('Dialog closed');
    const calls: number[] = [];
    const operation = load(async (requestedPage = 1) => { calls.push(requestedPage); return pendingPage.promise; }, controller.signal);
    controller.abort(reason);
    pendingPage.resolve(page([repository(1)], 2));
    expect(await rejectedError(operation)).toBe(reason);
    expect(calls).toEqual([1]);
  });

  test('starts a retry at page one and does not reuse partial results', async () => {
    let failing = true;
    const calls: number[] = [];
    const list: WorkspaceManagementApi['listGitHubRepositories'] = async (requestedPage = 1) => {
      calls.push(requestedPage);
      if (!failing) return page([repository(3)], null, 'new-owner');
      if (requestedPage === 1) return page([repository(1)], 2);
      throw new Error('Temporary failure');
    };
    await rejectedError(load(list));
    failing = false;
    expect(await load(list)).toEqual({ login: 'new-owner', repositories: [repository(3)] });
    expect(calls).toEqual([1, 2, 1]);
  });
});
