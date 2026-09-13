import { Bot, LogIn } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceCodexLoginState, WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { LoadingState, NeumorphicButton } from '../../../shared/ui';
import styles from './WorkspaceCodexLogin.module.css';

type LoginApi = Pick<WorkspaceManagementApi, 'getCodexLogin' | 'startCodexLogin' | 'cancelCodexLogin'>;
const checking: WorkspaceCodexLoginState = { state: 'checking', error: null };

export function WorkspaceCodexLoginView({ status, busy, ready, onLogin, onCancel, onRetry }: {
  status: WorkspaceCodexLoginState;
  busy: boolean;
  ready: boolean;
  onLogin: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (status.state === 'signed_in' && ready) return null;
  if (status.state === 'signed_in' || status.state === 'checking') {
    return <div className={styles.login} aria-label={status.state === 'checking' ? 'Checking Codex sign-in' : 'Preparing workspaces'}>
      <LoadingState type="preparing" />
    </div>;
  }
  return <div className={styles.login} aria-label="Codex sign-in">
    <Bot className={styles.mark} aria-hidden="true" />
    <h2>Welcome to Cheshi</h2>
    <p>Sign in with ChatGPT to start working with Cheshi.</p>
    {status.state === 'signing_in' && <>
      <span role="status">Complete sign-in in your browser…</span>
      <NeumorphicButton raised size="standard" disabled={busy} onClick={onCancel}>Cancel</NeumorphicButton>
    </>}
    {status.state === 'signed_out' && <NeumorphicButton raised size="standard" className={styles.continueButton} disabled={busy} onClick={onLogin}>
      <LogIn aria-hidden="true" />Continue with ChatGPT
    </NeumorphicButton>}
    {status.state === 'error' && <>
      <span className={styles.error} role="alert">{status.error ?? 'Could not check Codex sign-in.'}</span>
      <NeumorphicButton raised size="standard" disabled={busy} onClick={onRetry}>Retry</NeumorphicButton>
    </>}
  </div>;
}

export function WorkspaceCodexLogin({ api, ready, onAuthenticatedChange, onSettledChange }: {
  api: LoginApi;
  ready: boolean;
  onAuthenticatedChange: (authenticated: boolean) => void;
  onSettledChange?: (settled: boolean) => void;
}) {
  const [status, setStatus] = useState<WorkspaceCodexLoginState>(checking);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const pending = useRef(false);
  const refresh = useRef<() => void>(() => {});
  const run = async (action: () => Promise<WorkspaceCodexLoginState>): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const next = await action();
      if (active.current) setStatus(next);
    } catch {
      if (active.current) setStatus({ state: 'error', error: 'Codex sign-in is unavailable. Please try again.' });
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  refresh.current = () => { void run(() => api.getCodexLogin()); };
  useEffect(() => {
    active.current = true;
    refresh.current();
    const onFocus = () => refresh.current();
    window.addEventListener('focus', onFocus);
    return () => { active.current = false; window.removeEventListener('focus', onFocus); };
  }, [api]);
  useEffect(() => {
    if (status.state !== 'signing_in' && status.state !== 'checking') return;
    const timer = window.setInterval(() => refresh.current(), 1_000);
    return () => window.clearInterval(timer);
  }, [status.state]);
  useEffect(() => {
    onAuthenticatedChange(status.state === 'signed_in');
  }, [status.state, onAuthenticatedChange]);
  useEffect(() => { onSettledChange?.(status.state !== 'checking'); }, [status.state, onSettledChange]);
  return <WorkspaceCodexLoginView status={status} busy={busy} ready={ready}
    onLogin={() => { void run(() => api.startCodexLogin()); }}
    onCancel={() => { void run(() => api.cancelCodexLogin()); }} onRetry={() => { void run(() => api.startCodexLogin()); }} />;
}
