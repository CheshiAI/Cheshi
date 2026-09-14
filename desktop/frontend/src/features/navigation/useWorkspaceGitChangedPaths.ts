import { useEffect, useState } from 'react';

import { cheshiDesktop } from '../../cheshiDesktop';

export function useWorkspaceGitChangedPaths(): ReadonlySet<string> {
  const [changedPaths, setChangedPaths] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const desktop = cheshiDesktop;
    if (!desktop?.getGitSnapshot) return undefined;

    let canceled = false;
    let refreshing = false;
    let refreshRequested = false;

    const refresh = async (): Promise<void> => {
      if (canceled) return;
      refreshRequested = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (refreshRequested && !canceled) {
          refreshRequested = false;
          try {
            const snapshot = await desktop.getGitSnapshot();
            if (!canceled) {
              setChangedPaths(new Set(snapshot.available === true
                ? (snapshot.changes ?? []).map((change) => change.path)
                : []));
            }
          } catch {
            // Keep the last known decoration if a background Git read fails.
          }
        }
      } finally {
        refreshing = false;
      }
    };

    const refreshRepository = (): void => { void refresh(); };
    const refreshVisibleRepository = (): void => {
      if (document.visibilityState === 'visible') refreshRepository();
    };
    const unsubscribe = desktop.onGitRepositoryChanged?.(refreshRepository);
    window.addEventListener('focus', refreshRepository);
    document.addEventListener('visibilitychange', refreshVisibleRepository);
    refreshRepository();

    return () => {
      canceled = true;
      unsubscribe?.();
      window.removeEventListener('focus', refreshRepository);
      document.removeEventListener('visibilitychange', refreshVisibleRepository);
    };
  }, []);

  return changedPaths;
}
