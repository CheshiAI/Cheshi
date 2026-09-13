import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, LogIn } from 'lucide-react';
import type { GitHubLoginState } from '../../../../../shared/workspace-management';
import { NeumorphicButton, NeumorphicTextField } from '../../../shared/ui';
import { isGitHubLoginRequired, runGitHubLogin, type GitHubLoginApi } from './github-login';
import { workspaceError } from './workspace-paths';
import styles from './workspace-management.module.css';

const idle: GitHubLoginState = { state: 'idle', userCode: null, error: null };

export function GitHubSignIn({ api, error, onRetry, onManual, disabled = false }: {
  api: GitHubLoginApi; error: string; onRetry: () => void; onManual?: () => void; disabled?: boolean;
}) {
  const [status, setStatus] = useState(idle);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const attempt = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; attempt.current?.abort(); };
  }, []);

  const start = (): void => {
    if (attempt.current || disabled) return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true); setActionError(null); setCopied(false);
    setStatus({ state: 'starting', userCode: null, error: null });
    void runGitHubLogin({ api, signal: controller.signal, onState: setStatus,
      onBrowserError: (cause) => setActionError(workspaceError(cause)),
    }).then((complete) => { if (complete && !controller.signal.aborted) onRetry(); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setActionError(workspaceError(cause)); })
      .finally(() => {
        if (attempt.current === controller) {
          attempt.current = null;
          if (mounted.current) setBusy(false);
        }
      });
  };
  const cancel = (): void => {
    attempt.current?.abort();
    setStatus(idle); setActionError(null);
  };
  const runAction = async (action: () => Promise<void>): Promise<void> => {
    try { await action(); }
    catch (cause) { setActionError(workspaceError(cause)); }
  };
  const signInRequired = isGitHubLoginRequired(error);
  return <section className={styles.signIn} aria-label="GitHub sign in">
    {signInRequired ? <>
      <h2 className={styles.sectionLabel}>Sign in to GitHub</h2>
      <p className={styles.hint}>Connect your GitHub account to browse and clone your repositories.</p>
    </> : <p className={styles.error} role="alert">{error}</p>}
    {busy && <p className={styles.hint} role="status">
      {status.state === 'waiting' ? 'Enter this code on GitHub and authorize access. Your repositories will load automatically.' : 'Preparing GitHub sign in…'}
    </p>}
    {busy && status.userCode && <div className={styles.loginCode}>
      <NeumorphicTextField aria-label="GitHub verification code" readOnly value={status.userCode} />
      <NeumorphicButton raised size="standard" onClick={() => void runAction(async () => {
        await navigator.clipboard.writeText(status.userCode!); setCopied(true);
      })}><Copy />{copied ? 'Copied' : 'Copy code'}</NeumorphicButton>
      <NeumorphicButton raised size="standard" onClick={() => void runAction(() => api.openGitHubLoginBrowser())}><ExternalLink />Open browser</NeumorphicButton>
    </div>}
    {(actionError || status.error) && <p className={styles.error} role="alert">{actionError || status.error}</p>}
    <div className={styles.footer}>
      {busy ? <NeumorphicButton raised size="standard" onClick={cancel}>Cancel sign in</NeumorphicButton> : <>
        {onManual && <NeumorphicButton raised size="standard" disabled={disabled} onClick={onManual}>Enter repository URL</NeumorphicButton>}
        <NeumorphicButton raised size="standard" disabled={disabled} onClick={onRetry}>Retry</NeumorphicButton>
        {signInRequired && <NeumorphicButton raised size="standard" disabled={disabled} onClick={start}><LogIn />Sign in with GitHub</NeumorphicButton>}
      </>}
    </div>
  </section>;
}
