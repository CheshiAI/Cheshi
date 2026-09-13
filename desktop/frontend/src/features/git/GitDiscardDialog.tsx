import { GitPullRequestClosed } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../shared/errorMessage';
import { Modal, NeumorphicButton } from '../../shared/ui';
import { cheshiDesktop, type GitDiscardPreview, type GitDiscardRequest, type GitDiscardTarget } from '../../cheshiDesktop';
import styles from './GitDiscardDialog.module.css';

interface GitDiscardDialogProps {
  targets: GitDiscardTarget[];
  onClose: () => void;
  onDiscard: (request: GitDiscardRequest) => Promise<void>;
}

export function GitDiscardDialog({ targets, onClose, onDiscard }: GitDiscardDialogProps) {
  const [preview, setPreview] = useState<GitDiscardPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [revision, setRevision] = useState(0);
  const submittingRef = useRef(false);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setPreview(null);
    setError(null);
    const operation = cheshiDesktop?.prepareGitDiscard
      ? cheshiDesktop.prepareGitDiscard({ targets })
      : Promise.reject(new Error('Restart Cheshi to load the Git discard controls.'));
    void operation.then((result) => {
      if (!canceled) setPreview(result);
    }).catch((nextError: unknown) => {
      if (!canceled) setError(errorMessage(nextError));
    }).finally(() => {
      if (!canceled) setLoading(false);
    });
    return () => { canceled = true; };
  }, [targets, revision]);

  const close = (): void => {
    if (!submittingRef.current) onClose();
  };
  const discard = async (): Promise<void> => {
    if (!preview || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onDiscard({
        targets: preview.files.map(({ path, scope }) => ({ path, scope })),
        expectedRevision: preview.revision,
        confirmed: true,
      });
      onClose();
    } catch (nextError) {
      setError(errorMessage(nextError));
      setPreview(null);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Discard changes" titleIcon={<GitPullRequestClosed aria-hidden="true" />} className={styles.dialog} onClose={close}>
      <div className={styles.body} aria-busy={loading || submitting}>
        {loading && <p role="status">Checking selected files…</p>}
        {preview && (
          <>
            <p className={styles.description}>Discard changes in {preview.files.length} selected {preview.files.length === 1 ? 'file' : 'files'}?</p>
            <ul className={styles.files}>
              {preview.files.map((file) => (
                <li key={file.path}>
                  <strong>{file.path}</strong>
                  {file.oldPath && <span>Restore original path: {file.oldPath}</span>}
                  <span>{file.action === 'trash'
                    ? `Move this new file to Trash.${file.scope === 'staged' ? ' Remove it from staging.' : ''}`
                    : file.action === 'restore-index'
                      ? 'Discard unstaged changes. Keep the staged version.'
                      : 'Restore the last commit, discarding staged and unstaged changes.'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <NeumorphicButton size="standard" raised autoFocus disabled={submitting} onClick={close}>Cancel</NeumorphicButton>
          {!preview && !loading && (
            <NeumorphicButton size="standard" raised disabled={submitting} onClick={() => setRevision((current) => current + 1)}>
              Reload preview
            </NeumorphicButton>
          )}
          <NeumorphicButton size="standard" raised disabled={!preview || loading || submitting} onClick={() => void discard()}>
            {submitting ? 'Discarding…' : 'Discard changes'}
          </NeumorphicButton>
        </div>
      </div>
    </Modal>
  );
}
