import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from '../../shared/errorMessage';
import type { GitHubPullRequestCommit, GitHubPullRequestDiffResult, CheshiDesktopApi } from '../../cheshiDesktop';
import { parseUnifiedDiff, type UnifiedDiffFile } from './unifiedDiff';

interface CommitSelection {
  number: number;
  commit: GitHubPullRequestCommit;
}

interface CommitResult {
  selection: CommitSelection;
  diff: GitHubPullRequestDiffResult | null;
  files: UnifiedDiffFile[];
  error: string | null;
}

function sameCommit(left: CommitSelection | null, right: CommitSelection | null): boolean {
  return left?.number === right?.number && left?.commit.oid === right?.commit.oid;
}

export function useGitPullRequestCommitDiff(
  desktop: CheshiDesktopApi | undefined,
  number: number | null,
  active: boolean,
) {
  const [selection, setSelection] = useState<CommitSelection | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = selection?.number === number ? selection : null;
  const current = selected && sameCommit(result?.selection ?? null, selected) ? result : null;

  useEffect(() => {
    setSelection(null);
    setResult(null);
    setSelectedPath(null);
  }, [number]);

  useEffect(() => {
    if (!active || !selected || current || !desktop?.getGitHubPullRequestDiff) return undefined;
    let canceled = false;
    void desktop.getGitHubPullRequestDiff(selected.number, selected.commit.oid).then((diff) => {
      if (canceled) return;
      const files = parseUnifiedDiff(diff.patch);
      setResult({ selection: selected, diff, files, error: null });
      setSelectedPath(files[0]?.path ?? null);
    }).catch((error: unknown) => {
      if (!canceled) setResult({ selection: selected, diff: null, files: [], error: errorMessage(error) });
    });
    return () => { canceled = true; };
  }, [active, current, desktop, selected]);

  const selectCommit = useCallback((commit: GitHubPullRequestCommit): void => {
    if (number === null) return;
    const next = { number, commit };
    setSelection((previous) => sameCommit(previous, next) ? previous : next);
    setResult((previous) => previous?.error ? null : previous);
  }, [number]);

  return {
    selectedPullRequestCommit: selected?.commit ?? null,
    pullRequestDiff: current?.diff ?? null,
    pullRequestDiffFiles: current?.files ?? [],
    pullRequestDiffError: current?.error ?? null,
    pullRequestDiffLoading: Boolean(active && selected && !current && desktop?.getGitHubPullRequestDiff),
    selectedPullRequestDiffPath: current?.diff ? selectedPath : null,
    setSelectedPullRequestDiffPath: setSelectedPath,
    selectCommit,
  };
}
