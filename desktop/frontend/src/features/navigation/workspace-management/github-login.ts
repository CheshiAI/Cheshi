import type { GitHubLoginState, WorkspaceManagementApi } from '../../../../../shared/workspace-management';

export type GitHubLoginApi = Pick<WorkspaceManagementApi,
  'startGitHubLogin' | 'getGitHubLogin' | 'cancelGitHubLogin' | 'openGitHubLoginBrowser'>;

export function isGitHubLoginRequired(message: string): boolean {
  return /^Sign in to GitHub(?: CLI)?\b/u.test(message);
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 750);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function runGitHubLogin(options: {
  api: GitHubLoginApi;
  signal: AbortSignal;
  onState: (state: GitHubLoginState) => void;
  onBrowserError: (error: unknown) => void;
  wait?: (signal: AbortSignal) => Promise<void>;
}): Promise<boolean> {
  const { api, signal, onState, onBrowserError, wait = waitForPoll } = options;
  let completed = false;
  let browserOpened = false;
  let cancellation: Promise<void> | null = null;
  const cancel = () => { cancellation ??= api.cancelGitHubLogin().catch(() => undefined); };
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let status = await api.startGitHubLogin();
    while (!signal.aborted) {
      onState(status);
      if (status.state === 'complete') { completed = true; return true; }
      if (status.state === 'error' || status.state === 'idle') return false;
      if (status.state === 'waiting' && !browserOpened) {
        browserOpened = true;
        try { await api.openGitHubLoginBrowser(); }
        catch (error) { if (!signal.aborted) onBrowserError(error); }
      }
      signal.throwIfAborted();
      await wait(signal);
      signal.throwIfAborted();
      status = await api.getGitHubLogin();
    }
    return false;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!completed) { cancel(); await cancellation; }
  }
}
