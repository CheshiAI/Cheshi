import type { CheshiDesktopApi, GitRepositorySnapshot } from '../../cheshiDesktop';

type GitReader = Pick<CheshiDesktopApi, 'getGitSnapshot' | 'onGitRepositoryChanged'>;

interface VisibilityEvents {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export function workspaceGitBranchLabels(snapshot: GitRepositorySnapshot | null) {
  if (snapshot?.available !== true) {
    return { label: 'Git unavailable', title: snapshot?.message || 'Git is unavailable for this workspace.' };
  }
  if (snapshot.detached === true) {
    return { label: `Detached · ${snapshot.head || 'HEAD'}`, title: `Detached HEAD: ${snapshot.head || 'unknown commit'}` };
  }
  return snapshot.head
    ? { label: snapshot.head, title: `Current Git branch: ${snapshot.head}` }
    : { label: 'No branch', title: 'No committed Git branch is available yet.' };
}

/** Coalesce changes during a read and publish only the newest requested state. */
export function observeWorkspaceGitBranch(
  desktop: GitReader,
  update: (snapshot: GitRepositorySnapshot | null) => void,
  events: VisibilityEvents = { window, document },
) {
  let disposed = false;
  let pending = false;
  let revision = 0;

  const refresh = async () => {
    revision++;
    if (disposed || pending) return;
    pending = true;
    try {
      let requested: number;
      do {
        requested = revision;
        let snapshot: GitRepositorySnapshot | null;
        try { snapshot = await desktop.getGitSnapshot(); }
        catch { snapshot = null; }
        if (!disposed && requested === revision) update(snapshot);
      } while (!disposed && requested !== revision);
    } finally { pending = false; }
  };
  const onChange = () => { void refresh(); };
  const onVisible = () => {
    if (events.document.visibilityState === 'visible') onChange();
  };
  const unsubscribe = desktop.onGitRepositoryChanged(onChange);
  events.window.addEventListener('focus', onVisible);
  events.document.addEventListener('visibilitychange', onVisible);
  onChange();

  return () => {
    disposed = true;
    unsubscribe();
    events.window.removeEventListener('focus', onVisible);
    events.document.removeEventListener('visibilitychange', onVisible);
  };
}
