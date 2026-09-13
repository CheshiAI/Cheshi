import { useCallback, useEffect, useMemo, useState } from 'react';

import { errorMessage } from '../../shared/errorMessage';
import { isLiteralTrue } from '../../shared/isLiteralTrue';
import type {
  GitCommitSummary,
  GitDiffResult,
  GitRepositorySnapshot,
  CheshiDesktopApi,
} from '../../cheshiDesktop';
import { parseUnifiedDiff } from './unifiedDiff';

type HistoryReader = Pick<CheshiDesktopApi, 'getGitBranchCommits' | 'getGitDiff'>;
const EMPTY_COMMITS: GitCommitSummary[] = [];

interface HistoryQuery<T> {
  key: string | null;
  value: T | null;
  error: string | null;
  loading: boolean;
}

function useHistoryQuery<T>(
  key: string | null,
  load: () => Promise<T>,
  active: boolean,
  revision: number,
) {
  const [result, setResult] = useState<HistoryQuery<T>>({
    key: null, value: null, error: null, loading: false,
  });

  useEffect(() => {
    if (!active || key === null) return;
    let canceled = false;
    setResult({ key, value: null, error: null, loading: true });
    void load().then((value) => {
      if (!canceled) setResult({ key, value, error: null, loading: false });
    }).catch((error: unknown) => {
      if (!canceled) setResult({ key, value: null, error: errorMessage(error), loading: false });
    });
    return () => { canceled = true; };
  }, [active, key, load, revision]);

  if (key === null || result.key !== key) {
    return { value: null, error: null, loading: active && key !== null };
  }
  return result;
}

export function useGitBranchHistory(
  desktop: HistoryReader | undefined,
  snapshot: GitRepositorySnapshot,
  active: boolean,
) {
  const [requestedReference, setRequestedReference] = useState<string | null>(null);
  const [commitSelection, setCommitSelection] = useState<{ reference: string | null; hash: string } | null>(null);
  const [fileSelection, setFileSelection] = useState<{ commit: string; path: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const available = isLiteralTrue(snapshot.available);
  const branches = snapshot.branches;
  const selectedBranch = branches?.find((branch) => branch.fullName === requestedReference)
    ?? branches?.find((branch) => branch.current && !branch.remote)
    ?? null;
  const reference = selectedBranch?.fullName ?? null;
  const readSnapshot = selectedBranch === null || selectedBranch.current;
  const historyKey = available && reference ? `${reference}:${selectedBranch?.hash}` : null;

  useEffect(() => {
    if (available && requestedReference && !branches?.some((branch) => branch.fullName === requestedReference)) {
      setRequestedReference(null);
    }
  }, [available, branches, requestedReference]);

  const loadCommits = useCallback(async () => {
    if (!desktop?.getGitBranchCommits || !reference) {
      throw new Error('Branch history is unavailable. Restart Cheshi and try again.');
    }
    return desktop.getGitBranchCommits(reference);
  }, [desktop, reference]);
  const commitQuery = useHistoryQuery(readSnapshot ? null : historyKey, loadCommits, active, revision);
  const commits = available
    ? (readSnapshot ? snapshot.commits : commitQuery.value) ?? EMPTY_COMMITS
    : EMPTY_COMMITS;
  const selectedCommit = (commitSelection?.reference === reference
    ? commits.find((entry) => entry.hash === commitSelection?.hash)
    : null) ?? commits[0] ?? null;
  const commitHash = selectedCommit?.hash ?? null;

  const loadDiff = useCallback(async (): Promise<GitDiffResult> => {
    if (!desktop?.getGitDiff || !commitHash) throw new Error('Commit diff is unavailable.');
    return desktop.getGitDiff({ scope: 'commit', path: '', commit: commitHash });
  }, [commitHash, desktop]);
  const diffQuery = useHistoryQuery(commitHash, loadDiff, active, revision);
  const diff = diffQuery.value;
  const diffFiles = useMemo(() => parseUnifiedDiff(diff?.patch ?? ''), [diff]);
  const selectedDiffPath = fileSelection?.commit === commitHash
    && diffFiles.some((file) => file.path === fileSelection.path)
    ? fileSelection.path
    : diffFiles[0]?.path ?? null;

  const selectBranch = useCallback((nextReference: string) => {
    if (nextReference === reference) return;
    setRequestedReference(nextReference);
    setCommitSelection(null);
    setFileSelection(null);
  }, [reference]);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);

  return {
    branchName: selectedBranch?.name ?? snapshot.head ?? 'HEAD',
    selectedReference: reference,
    selectBranch,
    commits,
    commitsLoading: commitQuery.loading,
    selectedCommit,
    selectCommit: (hash: string) => setCommitSelection({ reference, hash }),
    diff,
    diffFiles,
    diffLoading: commitQuery.loading || diffQuery.loading,
    selectedDiffPath,
    selectDiffPath: (path: string) => {
      if (commitHash) setFileSelection({ commit: commitHash, path });
    },
    error: commitQuery.error ?? diffQuery.error,
    refresh,
  };
}
