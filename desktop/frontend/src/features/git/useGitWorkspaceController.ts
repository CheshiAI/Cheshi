import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../shared/errorMessage';
import { checkoutGitBranch } from './gitBranchCheckout';
import { refreshGitRepository, type GitRepositoryRefreshResult } from './gitRepositoryRefresh';
import { useGitBranchHistory } from './useGitBranchHistory';
import { useGitPullRequestCommitDiff } from './useGitPullRequestCommitDiff';
import {
  cheshiDesktop,
  type GitDiffRequest,
  type GitDiffResult,
  type GitDiscardRequest,
  type GitFileChange,
  type GitHubPullRequestCommit,
  type GitHubPullRequestDetails,
  type GitHubPullRequestListResult,
  type GitHubPullRequestMergeMethod,
  type GitHubPullRequestReviewCommentMode,
  type GitHubPullRequestReviewEvent,
  type GitHubPullRequestSummary,
  type GitRepositorySnapshot,
} from '../../cheshiDesktop';
import {
  changeScope,
  EMPTY_PULL_REQUESTS,
  EMPTY_SNAPSHOT,
  GIT_REMOTE_SYNC_INTERVAL_MS,
  sameGitDiffRequest,
  snapshotFingerprint,
  waitForMinimumLoadingFeedback,
  type GitMutationOutcome,
  type GitMutationSuccessMessage,
  type GitRefreshMode,
  type GitWorkspaceTab,
  type MergedPullRequestState,
  type PullRequestDetailTab,
  type PullRequestOperation,
  type PullRequestReviewLocation,
} from './gitWorkspaceModel';
import { parseUnifiedDiff, type UnifiedDiffFile } from './unifiedDiff';

export function useGitWorkspaceController() {
  const desktop = cheshiDesktop;
  const [tab, setTab] = useState<GitWorkspaceTab>('changes');
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot>(EMPTY_SNAPSHOT);
  const branchHistory = useGitBranchHistory(desktop, snapshot, tab === 'log');
  const { refresh: refreshBranchHistory } = branchHistory;
  const [pullRequests, setPullRequests] = useState<GitHubPullRequestListResult>(EMPTY_PULL_REQUESTS);
  const [selection, setSelection] = useState<GitDiffRequest | null>(null);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [localDiffRevision, setLocalDiffRevision] = useState(0);
  const [diffFiles, setDiffFiles] = useState<UnifiedDiffFile[]>([]);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedPullRequest, setSelectedPullRequest] = useState<GitHubPullRequestSummary | null>(null);
  const [mergedPullRequest, setMergedPullRequest] = useState<MergedPullRequestState | null>(null);
  const [pullRequestDetails, setPullRequestDetails] = useState<GitHubPullRequestDetails | null>(null);
  const [pullRequestDetailTab, setPullRequestDetailTab] = useState<PullRequestDetailTab>('conversation');
  const {
    pullRequestDiff,
    pullRequestDiffFiles,
    pullRequestDiffError,
    pullRequestDiffLoading,
    selectedPullRequestCommit,
    selectedPullRequestDiffPath,
    setSelectedPullRequestDiffPath,
    selectCommit,
  } = useGitPullRequestCommitDiff(desktop, selectedPullRequest?.number ?? null, tab === 'pull-requests');
  const [completedDetailsRequest, setCompletedDetailsRequest] = useState<{
    number: number;
    revision: number;
  } | null>(null);
  const [pullRequestDetailsRevision, setPullRequestDetailsRevision] = useState(0);
  const pullRequestDetailsLoading = Boolean(
    tab === 'pull-requests' && selectedPullRequest && desktop?.getGitHubPullRequestDetails
    && (completedDetailsRequest?.number !== selectedPullRequest.number
      || completedDetailsRequest?.revision !== pullRequestDetailsRevision),
  );
  const [pullRequestComment, setPullRequestComment] = useState('');
  const [pullRequestCommentSubmitting, setPullRequestCommentSubmitting] = useState(false);
  const [pullRequestReviewSubmitting, setPullRequestReviewSubmitting] = useState(false);
  const [pullRequestsLoading, setPullRequestsLoading] = useState(false);
  const [pullRequestCleanupChecking, setPullRequestCleanupChecking] = useState(false);
  const [mergeConfirmationNumber, setMergeConfirmationNumber] = useState<number | null>(null);
  const [mergeMethod, setMergeMethod] = useState<GitHubPullRequestMergeMethod>('merge');
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pullRequestOperation, setPullRequestOperation] = useState<PullRequestOperation>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fetchInFlightRef = useRef<Promise<GitRepositoryRefreshResult> | null>(null);
  const repositoryRefreshInFlightRef = useRef(false);
  const pullRequestsInFlightRef = useRef<Promise<string | null> | null>(null);
  const pullRequestsRefreshRequestedRef = useRef(false);
  const pullRequestCleanupInFlightRef = useRef<Promise<string | null> | null>(null);
  const refreshInFlightRef = useRef(false);
  const selectedPullRequestNumberRef = useRef<number | null>(null);
  const mergedPullRequestRef = useRef<MergedPullRequestState | null>(null);
  const snapshotFingerprintRef = useRef('');
  const snapshotRevisionRef = useRef(0);

  const acceptSnapshot = useCallback((nextSnapshot: GitRepositorySnapshot) => {
    // File contents can change while the Git status and selected path stay the same.
    setLocalDiffRevision((current) => current + 1);
    const nextFingerprint = snapshotFingerprint(nextSnapshot);
    if (nextFingerprint === snapshotFingerprintRef.current) return;
    snapshotFingerprintRef.current = nextFingerprint;
    snapshotRevisionRef.current += 1;
    setSnapshot(nextSnapshot);
    const changes = nextSnapshot.changes ?? [];
    setSelection((current) => {
      if (current?.scope === 'commit') return current;
      const currentChange = changes.find((change) => change.path === current?.path);
      const change = currentChange ?? changes[0];
      const nextSelection = change ? { scope: changeScope(change), path: change.path } : null;
      return sameGitDiffRequest(current, nextSelection) ? current : nextSelection;
    });
  }, []);

  const refreshSnapshot = useCallback(async (
    mode: GitRefreshMode = 'foreground',
  ): Promise<void> => {
    if (!desktop?.getGitSnapshot) {
      acceptSnapshot({ available: false, message: 'Git is available only in the Cheshi desktop application.' });
      setLoading(false);
      return;
    }
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    const revisionAtStart = snapshotRevisionRef.current;
    const foreground = mode === 'foreground';
    const feedbackStartedAt = foreground ? performance.now() : null;
    if (foreground) {
      setLoading(true);
      setError(null);
    }
    try {
      const nextSnapshot = await desktop.getGitSnapshot();
      if (snapshotRevisionRef.current === revisionAtStart) acceptSnapshot(nextSnapshot);
    } catch (nextError) {
      if (foreground) setError(errorMessage(nextError));
    } finally {
      if (feedbackStartedAt !== null) await waitForMinimumLoadingFeedback(feedbackStartedAt);
      refreshInFlightRef.current = false;
      if (foreground) setLoading(false);
    }
  }, [acceptSnapshot, desktop]);

  const refreshPullRequests = useCallback(async (
    mode: GitRefreshMode = 'foreground',
  ): Promise<string | null> => {
    if (!desktop?.listGitHubPullRequests) return null;
    if (pullRequestsInFlightRef.current) {
      pullRequestsRefreshRequestedRef.current = true;
      const message = await pullRequestsInFlightRef.current;
      if (mode === 'foreground' && message) setError(message);
      return message;
    }
    const foreground = mode === 'foreground';
    setPullRequestsLoading(true);
    if (foreground) {
      setBusy(true);
      setError(null);
    }
    const operation = (async (): Promise<string | null> => {
      try {
        do {
          pullRequestsRefreshRequestedRef.current = false;
          const result = await desktop.listGitHubPullRequests();
          setPullRequests(result);
          setPullRequestDetailsRevision((current) => current + 1);
          setMergeConfirmationNumber((current) => (
            result.pullRequests.some((pullRequest) => pullRequest.number === current) ? current : null
          ));
          setSelectedPullRequest((current) => {
            const currentPullRequest = result.pullRequests.find(
              (pullRequest) => pullRequest.number === current?.number,
            );
            if (currentPullRequest) return currentPullRequest;
            return mergedPullRequestRef.current ? null : result.pullRequests[0] ?? null;
          });
        } while (pullRequestsRefreshRequestedRef.current);
        return null;
      } catch (nextError) {
        const message = errorMessage(nextError);
        if (foreground) setError(message);
        return message;
      } finally {
        setPullRequestsLoading(false);
        if (foreground) setBusy(false);
      }
    })();
    pullRequestsInFlightRef.current = operation;
    try {
      return await operation;
    } finally {
      if (pullRequestsInFlightRef.current === operation) pullRequestsInFlightRef.current = null;
    }
  }, [desktop]);

  const fetchRepository = useCallback(async (
    mode: GitRefreshMode = 'foreground',
  ): Promise<void> => {
    if (!desktop?.getGitSnapshot) {
      await refreshSnapshot(mode);
      return;
    }
    const operation = fetchInFlightRef.current ?? refreshGitRepository(desktop);
    fetchInFlightRef.current = operation;
    try {
      const result = await operation;
      if (result.snapshot) acceptSnapshot(result.snapshot);
      if (mode === 'foreground') {
        if (result.error) setError(result.error);
        else setNotice('Repository refreshed.');
      }
    } finally {
      if (fetchInFlightRef.current === operation) fetchInFlightRef.current = null;
    }
  }, [acceptSnapshot, desktop, refreshSnapshot]);

  const refreshMergedPullRequestCleanup = useCallback(async (
    mode: GitRefreshMode = 'background',
  ): Promise<string | null> => {
    const mergedState = mergedPullRequestRef.current;
    if (
      !desktop?.getGitHubPullRequestBranchCleanupStatus
      || !mergedState
      || (!mergedState.branchDeleted && !mergedState.branchDeletionAvailable)
    ) return null;
    if (pullRequestCleanupInFlightRef.current) {
      const message = await pullRequestCleanupInFlightRef.current;
      if (mode === 'foreground' && message) setError(message);
      return message;
    }
    setPullRequestCleanupChecking(true);
    if (mode === 'foreground') {
      setError(null);
      setNotice(null);
    }
    const operation = (async (): Promise<string | null> => {
      try {
        const cleanup = await desktop.getGitHubPullRequestBranchCleanupStatus(
          mergedState.pullRequest.number,
        );
        const current = mergedPullRequestRef.current;
        if (current?.pullRequest.number !== cleanup.number) return null;
        const nextMergedState: MergedPullRequestState = {
          ...current,
          cleanup,
          cleanupError: null,
        };
        mergedPullRequestRef.current = nextMergedState;
        setMergedPullRequest(nextMergedState);
        acceptSnapshot(cleanup.snapshot);
        return null;
      } catch (nextError) {
        const message = errorMessage(nextError);
        const current = mergedPullRequestRef.current;
        if (current?.pullRequest.number === mergedState.pullRequest.number) {
          const nextMergedState = { ...current, cleanupError: message };
          mergedPullRequestRef.current = nextMergedState;
          setMergedPullRequest(nextMergedState);
        }
        if (mode === 'foreground') setError(message);
        await refreshSnapshot('background');
        return message;
      } finally {
        setPullRequestCleanupChecking(false);
      }
    })();
    pullRequestCleanupInFlightRef.current = operation;
    try {
      return await operation;
    } finally {
      if (pullRequestCleanupInFlightRef.current === operation) pullRequestCleanupInFlightRef.current = null;
    }
  }, [acceptSnapshot, desktop, refreshSnapshot]);

  const syncRemoteRepository = useCallback(async (
    mode: GitRefreshMode = 'foreground',
  ): Promise<void> => {
    const mergedState = mergedPullRequestRef.current;
    if (mergedState && (mergedState.branchDeleted || mergedState.branchDeletionAvailable)) {
      await refreshMergedPullRequestCleanup(mode);
      return;
    }
    await fetchRepository(mode);
  }, [fetchRepository, refreshMergedPullRequestCleanup]);

  const refreshRepository = useCallback(async (): Promise<void> => {
    if (repositoryRefreshInFlightRef.current) return;
    repositoryRefreshInFlightRef.current = true;
    setRefreshing(true);
    setError(null);
    setNotice(null);
    const feedbackStartedAt = performance.now();
    try {
      await syncRemoteRepository();
      if (tab === 'log') refreshBranchHistory();
      if (tab === 'pull-requests') {
        const message = await refreshPullRequests('background');
        if (message) setError(message);
      }
    } finally {
      await waitForMinimumLoadingFeedback(feedbackStartedAt);
      repositoryRefreshInFlightRef.current = false;
      setRefreshing(false);
    }
  }, [refreshBranchHistory, refreshPullRequests, syncRemoteRepository, tab]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (!desktop?.getGitSnapshot) return undefined;

    const refreshLocalRepository = (): void => {
      void refreshSnapshot('background');
      void refreshMergedPullRequestCleanup('background');
      if (tab === 'pull-requests') void refreshPullRequests('background');
    };
    const refreshVisibleRepository = (): void => {
      if (document.visibilityState !== 'visible') return;
      void syncRemoteRepository('background');
      if (tab === 'pull-requests') void refreshPullRequests('background');
    };
    const unsubscribe = desktop.onGitRepositoryChanged?.(refreshLocalRepository) ?? (() => {});
    window.addEventListener('focus', refreshVisibleRepository);
    document.addEventListener('visibilitychange', refreshVisibleRepository);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', refreshVisibleRepository);
      document.removeEventListener('visibilitychange', refreshVisibleRepository);
    };
  }, [desktop, refreshMergedPullRequestCleanup, refreshPullRequests, syncRemoteRepository, tab]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void syncRemoteRepository('background');
      if (tab === 'pull-requests') void refreshPullRequests('background');
    }, GIT_REMOTE_SYNC_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [refreshPullRequests, syncRemoteRepository, tab]);

  useEffect(() => {
    if (tab === 'pull-requests') void refreshPullRequests();
  }, [refreshPullRequests, tab]);

  useEffect(() => {
    const pullRequestNumber = selectedPullRequest?.number;
    if (tab !== 'pull-requests' || !pullRequestNumber || !desktop?.getGitHubPullRequestDetails) {
      setPullRequestDetails(null);
      setCompletedDetailsRequest(null);
      return undefined;
    }

    let canceled = false;
    setPullRequestDetails((current) => (
      current?.number === pullRequestNumber ? current : null
    ));
    setCompletedDetailsRequest(null);
    void desktop.getGitHubPullRequestDetails(pullRequestNumber).then((details) => {
      if (!canceled) setPullRequestDetails(details);
    }).catch((nextError: unknown) => {
      if (!canceled) setError(errorMessage(nextError));
    }).finally(() => {
      if (!canceled) setCompletedDetailsRequest({
        number: pullRequestNumber,
        revision: pullRequestDetailsRevision,
      });
    });

    return () => {
      canceled = true;
    };
  }, [desktop, pullRequestDetailsRevision, selectedPullRequest?.number, tab]);

  useEffect(() => {
    selectedPullRequestNumberRef.current = selectedPullRequest?.number ?? null;
    setPullRequestDetailTab('conversation');
    setPullRequestComment('');
    setMergeConfirmationNumber(null);
  }, [selectedPullRequest?.number]);

  const selectedDiffRevision = selection?.scope === 'commit' ? 0 : localDiffRevision;

  useEffect(() => {
    if (!selection || !cheshiDesktop?.getGitDiff) {
      setDiff(null);
      setDiffFiles([]);
      setSelectedDiffPath(null);
      return;
    }
    let canceled = false;
    setDiffLoading(true);
    void cheshiDesktop.getGitDiff(selection).then((result) => {
      if (canceled) return;
      const files = parseUnifiedDiff(result.patch);
      setDiff(result);
      setDiffFiles(files);
      setSelectedDiffPath((current) => (
        files.some((file) => file.path === current) ? current : files[0]?.path ?? null
      ));
    }).catch((nextError: unknown) => {
      if (!canceled) setError(errorMessage(nextError));
    }).finally(() => {
      if (!canceled) setDiffLoading(false);
    });
    return () => {
      canceled = true;
    };
  }, [selection, selectedDiffRevision]);

  const changes = snapshot.changes ?? [];
  const stagedChanges = changes.filter((change) => change.staged);
  const unstagedChanges = changes.filter((change) => change.unstaged);
  const pullRequestHasNoCommits = snapshot.pullRequestAhead === 0;
  const pullRequestNeedsPush = (
    !snapshot.upstream
    || snapshot.upstreamPublished === false
    || (snapshot.ahead ?? 0) > 0
  );
  let pullRequestEmptyMessage = snapshot.head
    ? `No open pull request for ${snapshot.head}`
    : 'Check out a local branch to create a pull request.';
  if (mergedPullRequest) {
    pullRequestEmptyMessage = `Pull request #${mergedPullRequest.pullRequest.number} was merged.`;
  } else if (snapshot.detached === true || !snapshot.head) {
    pullRequestEmptyMessage = 'Check out a local branch to create a pull request.';
  } else if (pullRequestHasNoCommits) {
    pullRequestEmptyMessage = changes.length > 0
      ? `Commit local changes before creating a pull request from ${snapshot.head}.`
      : `${snapshot.head} is already included in ${snapshot.pullRequestBase ?? 'the default branch'}.`;
  } else if (pullRequestNeedsPush) {
    pullRequestEmptyMessage = `Push ${snapshot.head} before creating a pull request.`;
  }
  const selectedPullRequestIsCurrentBranch = selectedPullRequest?.headRefName === snapshot.head;
  const selectedPullRequestNeedsPush = selectedPullRequestIsCurrentBranch && pullRequestNeedsPush;
  const runMutation = useCallback(async (
    operation: () => Promise<GitMutationOutcome>,
    successMessage: GitMutationSuccessMessage,
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await operation();
      acceptSnapshot('snapshot' in result ? result.snapshot : result);
      setNotice(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      return true;
    } catch (nextError) {
      setError(errorMessage(nextError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [acceptSnapshot]);

  const selectChange = useCallback((change: GitFileChange, scope = changeScope(change)): void => {
    const nextSelection: GitDiffRequest = { scope, path: change.path };
    setSelection((current) => (
      sameGitDiffRequest(current, nextSelection) ? current : nextSelection
    ));
  }, []);

  const selectTab = (nextTab: GitWorkspaceTab): void => {
    setTab(nextTab);
    setNotice(null);
    if (nextTab === 'changes') {
      const first = changes[0];
      setSelection(first ? { scope: changeScope(first), path: first.path } : null);
    }
  };

  const commit = async (): Promise<void> => {
    if (!cheshiDesktop || !commitMessage.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cheshiDesktop.commitGitChanges(commitMessage);
      acceptSnapshot(result.snapshot);
      setCommitMessage('');
      setNotice('Commit created.');
      await refreshMergedPullRequestCleanup('background');
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  };

  const pushCurrentBranch = async (): Promise<boolean> => {
    if (!desktop?.pushGitCurrentBranch || !snapshot.head) return false;
    const branch = snapshot.head;
    setPullRequestOperation('push');
    try {
      const pushed = await runMutation(
        () => desktop.pushGitCurrentBranch(),
        `Pushed ${branch}.`,
      );
      if (pushed && tab === 'pull-requests') await refreshPullRequests('background');
      return pushed;
    } finally {
      setPullRequestOperation(null);
    }
  };

  const pushMergedPullRequestBranch = async (): Promise<void> => {
    const mergedState = mergedPullRequestRef.current;
    if (!mergedState || mergedState.cleanup?.canPush !== true || mergedState.cleanupError !== null
      || busy || pullRequestCleanupChecking || snapshot.head !== mergedState.pullRequest.headRefName) return;
    const pushed = await pushCurrentBranch();
    if (!pushed) return;
    mergedPullRequestRef.current = null;
    setMergedPullRequest(null);
  };

  const createPullRequest = async (): Promise<void> => {
    if (!desktop?.createGitHubPullRequest) return;
    setPullRequestOperation('create');
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const pullRequest = await desktop.createGitHubPullRequest();
      setPullRequests((current) => ({
        available: true,
        message: '',
        pullRequests: [
          pullRequest,
          ...current.pullRequests.filter((entry) => entry.number !== pullRequest.number),
        ],
      }));
      mergedPullRequestRef.current = null;
      setMergedPullRequest(null);
      setSelectedPullRequest(pullRequest);
      setNotice(`Created pull request #${pullRequest.number}.`);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
      setPullRequestOperation(null);
    }
  };

  const mergePullRequest = async (): Promise<void> => {
    const pullRequest = selectedPullRequest;
    if (
      !desktop?.mergeGitHubPullRequest
      || !pullRequest
      || mergeConfirmationNumber !== pullRequest.number
    ) return;
    setPullRequestOperation('merge');
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await desktop.mergeGitHubPullRequest({
        number: pullRequest.number,
        method: mergeMethod,
      });
      const remainingPullRequests = pullRequests.pullRequests.filter((entry) => entry.number !== result.number);
      setPullRequests({
        available: true,
        message: '',
        pullRequests: remainingPullRequests,
      });
      const mergedState: MergedPullRequestState = {
        pullRequest: {
          ...pullRequest,
          headRefName: result.headRefName,
        },
        branchDeletionAvailable: result.branchDeletionAvailable,
        branchDeleted: false,
        cleanup: null,
        cleanupError: null,
      };
      mergedPullRequestRef.current = mergedState;
      setMergedPullRequest(mergedState);
      setSelectedPullRequest(null);
      setMergeConfirmationNumber(null);
      setNotice(`Merged pull request #${result.number}.`);
      await refreshMergedPullRequestCleanup('background');
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
      setPullRequestOperation(null);
    }
  };

  const deleteMergedPullRequestBranch = async (): Promise<void> => {
    const mergedState = mergedPullRequest;
    if (
      !desktop?.deleteGitHubPullRequestBranch
      || !mergedState
      || !mergedState.branchDeletionAvailable
      || mergedState.branchDeleted
      || pullRequestCleanupChecking
      || mergedState.cleanupError !== null
      || !['remote-branch-present', 'complete'].includes(mergedState.cleanup?.state ?? '')
      || changes.length > 0
    ) return;
    setPullRequestOperation('delete-branch');
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await desktop.deleteGitHubPullRequestBranch(mergedState.pullRequest.number);
      const nextMergedState: MergedPullRequestState = {
        ...mergedState,
        pullRequest: {
          ...mergedState.pullRequest,
          headRefName: result.branch,
        },
        branchDeleted: true,
        cleanup: result.cleanup,
        cleanupError: result.refreshWarning,
      };
      mergedPullRequestRef.current = nextMergedState;
      setMergedPullRequest(nextMergedState);
      acceptSnapshot(result.snapshot);
      setNotice(`Deleted remote branch ${result.branch}.`);
      if (result.refreshWarning) {
        setError(`The remote branch was deleted, but local remote references could not be refreshed: ${result.refreshWarning}`);
      }
      await refreshPullRequests('background');
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
      setPullRequestOperation(null);
    }
  };

  const cleanupMergedPullRequestBranch = async (): Promise<void> => {
    const mergedState = mergedPullRequest;
    if (
      !desktop?.cleanupGitHubPullRequestBranch
      || !mergedState?.branchDeleted
      || mergedState.cleanup?.canCleanup !== true
    ) return;
    setPullRequestOperation('cleanup-branch');
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await desktop.cleanupGitHubPullRequestBranch(
        mergedState.pullRequest.number,
      );
      acceptSnapshot(result.snapshot);
      mergedPullRequestRef.current = null;
      setMergedPullRequest(null);
      setNotice(result.output);
      await refreshPullRequests('background');
    } catch (nextError) {
      setError(errorMessage(nextError));
      await refreshMergedPullRequestCleanup('background');
    } finally {
      setBusy(false);
      setPullRequestOperation(null);
    }
  };

  const addPullRequestComment = async (): Promise<void> => {
    const pullRequest = selectedPullRequest;
    const body = pullRequestComment.trim();
    if (!desktop?.addGitHubPullRequestComment || !pullRequest || !body) return;
    setPullRequestCommentSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const details = await desktop.addGitHubPullRequestComment({
        number: pullRequest.number,
        body,
      });
      if (selectedPullRequestNumberRef.current === pullRequest.number) {
        setPullRequestDetails(details);
        setPullRequestComment('');
        setNotice(`Added comment to pull request #${pullRequest.number}.`);
      }
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setPullRequestCommentSubmitting(false);
    }
  };

  const addPullRequestReviewComment = async (
    location: PullRequestReviewLocation,
    body: string,
    mode: GitHubPullRequestReviewCommentMode,
  ): Promise<boolean> => {
    const pullRequest = selectedPullRequest;
    const details = pullRequestDetails;
    const reviewDiff = pullRequestDiff;
    if (
      !desktop?.addGitHubPullRequestReviewComment
      || !pullRequest
      || !details
      || !reviewDiff
      || reviewDiff.number !== pullRequest.number
    ) return false;
    setPullRequestReviewSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const nextDetails = await desktop.addGitHubPullRequestReviewComment({
        number: pullRequest.number,
        pullRequestId: details.id,
        commitId: reviewDiff.headRefOid,
        path: location.path,
        line: location.line,
        side: location.side,
        body,
        mode,
        pendingReviewId: mode === 'review' ? details.pendingReview?.id ?? null : null,
      });
      if (selectedPullRequestNumberRef.current === pullRequest.number) {
        setPullRequestDetails(nextDetails);
        setNotice(mode === 'review'
          ? `${details.pendingReview ? 'Added a comment to' : 'Started'} review on pull request #${pullRequest.number}.`
          : `Added an inline comment to pull request #${pullRequest.number}.`);
      }
      return true;
    } catch (nextError) {
      setError(errorMessage(nextError));
      return false;
    } finally {
      setPullRequestReviewSubmitting(false);
    }
  };

  const submitPullRequestReview = async (
    event: GitHubPullRequestReviewEvent,
  ): Promise<boolean> => {
    const pullRequest = selectedPullRequest;
    const pendingReview = pullRequestDetails?.pendingReview;
    if (!desktop?.submitGitHubPullRequestReview || !pullRequest || !pendingReview) return false;
    setPullRequestReviewSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const details = await desktop.submitGitHubPullRequestReview({
        number: pullRequest.number,
        reviewId: pendingReview.id,
        event,
      });
      if (selectedPullRequestNumberRef.current === pullRequest.number) {
        setPullRequestDetails(details);
        setNotice(`Submitted review on pull request #${pullRequest.number}.`);
      }
      return true;
    } catch (nextError) {
      setError(errorMessage(nextError));
      return false;
    } finally {
      setPullRequestReviewSubmitting(false);
    }
  };

  const selectPullRequest = (pullRequest: GitHubPullRequestSummary): void => {
    mergedPullRequestRef.current = null;
    setMergedPullRequest(null);
    setSelectedPullRequest(pullRequest);
    setMergeConfirmationNumber(null);
  };

  const selectPullRequestCommit = (entry: GitHubPullRequestCommit): void => {
    if (pullRequestDetails?.number !== selectedPullRequest?.number
      || !pullRequestDetails?.commits.some((commit) => commit.oid === entry.oid)) return;
    selectCommit(entry);
    setPullRequestDetailTab('changes');
  };

  const beginMerge = (pullRequest: GitHubPullRequestSummary): void => {
    setPullRequestDetailTab('conversation');
    setMergeMethod('merge');
    setMergeConfirmationNumber(pullRequest.number);
    setError(null);
    setNotice(null);
  };

  const stagePaths = (paths: string[], successMessage: string): Promise<boolean> => (
    desktop ? runMutation(() => desktop.stageGitPaths(paths), successMessage) : Promise.resolve(false)
  );

  const unstagePaths = (paths: string[], successMessage: string): Promise<boolean> => (
    desktop ? runMutation(() => desktop.unstageGitPaths(paths), successMessage) : Promise.resolve(false)
  );

  const discardChanges = async (request: GitDiscardRequest): Promise<void> => {
    if (!desktop?.discardGitChanges) throw new Error('Git discard is unavailable. Restart Cheshi and try again.');
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      acceptSnapshot(await desktop.discardGitChanges(request));
      setNotice(`Discarded changes in ${request.targets.length} file(s).`);
    } catch (nextError) {
      setError(errorMessage(nextError));
      await refreshSnapshot('background');
      throw nextError;
    } finally {
      setBusy(false);
    }
  };

  const checkoutBranch = (branchName: string): void => {
    if (desktop) void runMutation(() => checkoutGitBranch(desktop, branchName), `Checked out ${branchName}.`);
  };

  const createBranch = (
    branchName: string,
    startPoint: string,
    startPointLabel: string,
  ): Promise<boolean> => (
    desktop
      ? runMutation(
        () => desktop.createGitBranch(branchName, startPoint),
        `Created ${branchName} from ${startPointLabel}.`,
      )
      : Promise.resolve(false)
  );

  const updateBranch = (fullName: string, displayName: string): void => {
    if (!desktop) return;
    void runMutation(
      () => desktop.updateGitBranch(fullName),
      (result) => ('output' in result && result.output) || `Updated ${displayName}.`,
    );
  };

  const checkoutPullRequest = (pullRequestNumber: number): void => {
    if (desktop) {
      void runMutation(
        () => desktop.checkoutGitHubPullRequest(pullRequestNumber),
        `Checked out pull request #${pullRequestNumber}.`,
      );
    }
  };

  const openPullRequest = (url: string): void => {
    if (desktop) void desktop.openGitHubPullRequest(url);
  };

  return {
    addPullRequestComment,
    addPullRequestReviewComment,
    beginMerge,
    branchHistory,
    busy: busy || refreshing,
    changes,
    checkoutBranch,
    checkoutPullRequest,
    cleanupMergedPullRequestBranch,
    commit,
    commitMessage,
    createBranch,
    createPullRequest,
    deleteMergedPullRequestBranch,
    diff,
    diffFiles,
    diffLoading,
    discardChanges,
    error,
    loading,
    mergeConfirmationNumber,
    mergeMethod,
    mergePullRequest,
    mergedPullRequest,
    notice,
    openPullRequest,
    pullRequestCleanupChecking,
    pullRequestComment,
    pullRequestCommentSubmitting,
    pullRequestDetailTab,
    pullRequestDetails,
    pullRequestDetailsLoading,
    pullRequestDiff,
    pullRequestDiffError,
    pullRequestDiffFiles,
    pullRequestDiffLoading,
    pullRequestEmptyMessage,
    pullRequestHasNoCommits,
    pullRequestNeedsPush,
    pullRequestOperation,
    pullRequestReviewSubmitting,
    pullRequests,
    pullRequestsLoading,
    pushCurrentBranch,
    pushMergedPullRequestBranch,
    refreshPullRequests,
    refreshRepository,
    refreshing: loading || refreshing || pullRequestCleanupChecking,
    selectChange,
    selection,
    selectedDiffPath,
    selectedPullRequest,
    selectedPullRequestCommit,
    selectedPullRequestDiffPath,
    selectedPullRequestNeedsPush,
    selectPullRequest,
    selectPullRequestCommit,
    selectTab,
    setCommitMessage,
    setMergeConfirmationNumber,
    setMergeMethod,
    setPullRequestComment,
    setPullRequestDetailTab,
    setSelectedDiffPath,
    setSelectedPullRequestDiffPath,
    setSelection,
    snapshot,
    stagedChanges,
    stagePaths,
    submitPullRequestReview,
    tab,
    unstagedChanges,
    unstagePaths,
    updateBranch,
  };
}

export type GitWorkspaceController = ReturnType<typeof useGitWorkspaceController>;
