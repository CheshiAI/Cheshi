import type { CheshiDesktopApi, GitRepositorySnapshot, WorkspaceFilesChangedEvent } from '../cheshiDesktop';
import { absoluteProjectPath } from '../../../shared/workspace-projects';

type GitReader = Pick<CheshiDesktopApi, 'getGitSnapshot' | 'onGitRepositoryChanged'>
  & Partial<Pick<CheshiDesktopApi, 'workspaceRoot' | 'onWorkspaceFilesChanged'>>;
type Listener = (snapshot: GitRepositorySnapshot | null) => void;
interface VisibilityEvents {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}
interface Subscription {
  listeners: Set<Listener>;
  snapshot: GitRepositorySnapshot | null;
  ready: boolean;
  stop: () => void;
}

const subscriptions = new WeakMap<GitReader, Subscription>();

/** Primary events are relative; linked project events carry absolute paths. */
export function workspaceGitEventAffectsProject(
  event: WorkspaceFilesChangedEvent, root: string | undefined, includeRelative: boolean,
): boolean {
  // Overflow has no reliable project identity, so every observer must recover.
  if (event.overflow === true) return true;
  const normalizedRoot = root?.replace(/\\/gu, '/').replace(/\/$/u, '');
  return event.paths.some(file => {
    if (!absoluteProjectPath(file)) return includeRelative;
    const normalizedPath = file.replace(/\\/gu, '/');
    return normalizedRoot !== undefined
      && (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`));
  });
}

export function workspaceGitChangedPaths(snapshot: GitRepositorySnapshot | null): ReadonlySet<string> {
  if (snapshot?.available !== true) return new Set();
  return new Set((snapshot.changes ?? [])
    .filter(change => change.staged === true || change.unstaged === true || change.untracked === true)
    .map(change => change.path));
}

/** Share one current snapshot and event subscription while consumers are mounted. */
export function observeWorkspaceGitStatus(
  desktop: GitReader,
  update: Listener,
  events: VisibilityEvents = { window, document },
) {
  let subscription = subscriptions.get(desktop);
  if (!subscription) {
    const current: Subscription = { listeners: new Set(), snapshot: null, ready: false, stop: () => {} };
    subscription = current;
    subscriptions.set(desktop, current);
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
          if (!disposed && requested === revision) {
            current.snapshot = snapshot;
            current.ready = true;
            for (const listener of current.listeners) listener(snapshot);
          }
        } while (!disposed && requested !== revision);
      } finally { pending = false; }
    };
    const onChange = () => { void refresh(); };
    const onVisible = () => {
      if (events.document.visibilityState === 'visible') onChange();
    };
    const unsubscribe = desktop.onGitRepositoryChanged(onChange);
    const unsubscribeFiles = desktop.onWorkspaceFilesChanged?.(event => {
      if (workspaceGitEventAffectsProject(event, desktop.workspaceRoot, true)) onChange();
    });
    events.window.addEventListener('focus', onVisible);
    events.document.addEventListener('visibilitychange', onVisible);
    current.stop = () => {
      disposed = true;
      unsubscribe();
      unsubscribeFiles?.();
      events.window.removeEventListener('focus', onVisible);
      events.document.removeEventListener('visibilitychange', onVisible);
      subscriptions.delete(desktop);
    };
    onChange();
  }
  // Each subscriber owns a distinct callback, even if callers reuse update.
  const listener: Listener = snapshot => update(snapshot);
  subscription.listeners.add(listener);
  if (subscription.ready) listener(subscription.snapshot);
  return () => {
    if (!subscription.listeners.delete(listener)) return;
    if (subscription.listeners.size === 0) subscription.stop();
  };
}
