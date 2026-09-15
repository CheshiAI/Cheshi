import type { CheshiDesktopApi, GitRepositorySnapshot } from '../cheshiDesktop';

type GitReader = Pick<CheshiDesktopApi, 'getGitSnapshot' | 'onGitRepositoryChanged'>;
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
    events.window.addEventListener('focus', onVisible);
    events.document.addEventListener('visibilitychange', onVisible);
    current.stop = () => {
      disposed = true;
      unsubscribe();
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
