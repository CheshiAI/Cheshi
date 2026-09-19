import { GitCommitHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { GitLineBlameRequest, GitLineCommit } from '../../../../shared/git-line-blame';
import { cheshiDesktop as workspace } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';
import { LiquidGlassPanel, LoadingState, NeumorphicButton } from '../../shared/ui';
import { GitDiffViewer } from '../git/GitDiffViewer';
import { parseUnifiedDiff } from '../git/unifiedDiff';
import gitStyles from '../git/GitWorkspace.module.css';
import styles from './WorkspaceLineCommitPanel.module.css';

async function readLineCommit(request: GitLineBlameRequest) {
  if (!workspace?.getGitLineCommit) throw new Error('Line commit details are unavailable. Restart Cheshi and try again.');
  return workspace.getGitLineCommit(request);
}

export function WorkspaceLineCommitPanel({ request, onClose, read = readLineCommit }: {
  request: GitLineBlameRequest;
  onClose: () => void;
  read?: (request: GitLineBlameRequest) => Promise<GitLineCommit>;
}) {
  const [response, setResponse] = useState<{ request: GitLineBlameRequest; result: GitLineCommit | null; error: string | null } | null>(null);
  const result = response?.request === request ? response.result : null;
  const error = response?.request === request ? response.error : null;
  useEffect(() => {
    let cancelled = false;
    void read(request).then(value => { if (!cancelled) setResponse({ request, result: value, error: null }); })
      .catch((reason: unknown) => { if (!cancelled) setResponse({ request, result: null, error: errorMessage(reason) }); });
    return () => { cancelled = true; };
  }, [read, request]);
  const commit = result?.status === 'committed' ? result : null;
  const files = useMemo(() => parseUnifiedDiff(commit?.patch ?? '')
    .filter(file => file.path === commit?.blame.originalPath), [commit?.patch, commit?.blame.originalPath]);
  const target = commit ? { path: commit.blame.originalPath, line: commit.blame.originalLine } : undefined;
  const targetPresent = target && files.some(file => file.path === target.path && file.lines.some(line => line.newLine === target.line));
  return (
    <LiquidGlassPanel as="section" aria-label="Line commit" className={styles.panel}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <header className={styles.header}>
        <div className={styles.title}>
          <NeumorphicButton raised className={`theme-toggle ${styles.titleMark}`} disabled aria-hidden="true">
            <GitCommitHorizontal aria-hidden="true" />
          </NeumorphicButton>
          <h2>Line commit</h2>
        </div>
        <NeumorphicButton raised size="icon" aria-label="Close line commit" onClick={onClose}><X aria-hidden="true" /></NeumorphicButton>
      </header>
      <div className={styles.body}>
        <p className={styles.origin}>{request.path}:{request.line} · Last change</p>
        {error ? <p role="alert">{error}</p> : !result ? <LoadingState />
          : result.status === 'uncommitted' ? <p role="status">This line has not been committed yet.</p>
            : result.status === 'unavailable' ? <p role="status">Git history is unavailable for this line.</p> : null}
        {commit && <>
          <div className={styles.metadata}>
            <span>{commit.blame.author} · {new Date(commit.blame.authoredAt).toLocaleString()}</span>
            <code>{commit.blame.hash}</code>
            <pre>{commit.message}</pre>
            {commit.messageTruncated && <p role="status">Commit message was truncated.</p>}
            <span>At commit: {commit.blame.originalPath}:{commit.blame.originalLine}</span>
            {!targetPresent && <p role="status">The target line is not present in the available diff.</p>}
          </div>
          <div className={`${styles.diff} ${gitStyles.workspace}`}>
            <GitDiffViewer diff={{ path: commit.blame.originalPath, truncated: commit.truncated, binary: false }} files={files}
              loading={false} selectedPath={commit.blame.originalPath}
              targetLine={target} emptyMessage="No text changes are available for this file in this commit."
              embedded />
          </div>
        </>}
      </div>
    </LiquidGlassPanel>
  );
}
