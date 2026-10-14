import { Bot, LogIn } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceCodexLoginState, WorkspaceManagementApi } from '../../../../../shared/workspace-management';
import { EmptyState, LoadingState, NeumorphicButton } from '../../../shared/ui';
import styles from './WorkspaceCodexLogin.module.css';

type LoginApi = Pick<WorkspaceManagementApi, 'getCodexLogin' | 'startCodexLogin' | 'cancelCodexLogin'>;
const checking: WorkspaceCodexLoginState = { state: 'checking', error: null };

export function WorkspaceCodexLoginActions({ status, busy, onLogin, onCancel, onRetry }: {
  status: WorkspaceCodexLoginState;
  busy: boolean;
  onLogin: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (status.state === 'signing_in') {
    return <NeumorphicButton variant="standard" disabled={busy} onClick={onCancel}>Cancel</NeumorphicButton>;
  }
  if (status.state === 'error') {
    return <NeumorphicButton variant="standard" disabled={busy} onClick={onRetry}>Retry</NeumorphicButton>;
  }
  if (status.state !== 'signed_out') return null;
  return <NeumorphicButton variant="standard" className={styles.continueButton} disabled={busy} onClick={onLogin}>
    <LogIn aria-hidden="true" />Continue with ChatGPT
  </NeumorphicButton>;
}

export function WorkspaceCodexLoginView({ status, ready }: {
  status: WorkspaceCodexLoginState;
  ready: boolean;
}) {
  if (status.state === 'signed_in' && ready) return null;
  if (status.state === 'signed_in' || status.state === 'checking') {
    return <div className={styles.login} aria-label={status.state === 'checking' ? 'Checking Codex sign-in' : 'Preparing workspaces'}>
      <LoadingState type="preparing" />
    </div>;
  }
  return <div className={styles.login} aria-label="Codex sign-in">
    <EmptyState className={styles.copy} variant="section" icon={<Bot />} title="Welcome to Cheshi"
      description="Sign in with ChatGPT to start working with Cheshi." />
    {status.state === 'signing_in' && <span role="status">Complete sign-in in your browser…</span>}
    {status.state === 'error' && <span className={styles.error} role="alert">{status.error ?? 'Could not check Codex sign-in.'}</span>}
  </div>;
}

export function WorkspaceCodexLogin({ api, ready, actionsTarget, onAuthenticatedChange, onSettledChange }: {
  api: LoginApi;
  ready: boolean;
  actionsTarget: HTMLElement | null;
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
  return <>
    <WorkspaceCodexLoginView status={status} ready={ready} />
    {actionsTarget && createPortal(<WorkspaceCodexLoginActions status={status} busy={busy}
      onLogin={() => { void run(() => api.startCodexLogin()); }}
      onCancel={() => { void run(() => api.cancelCodexLogin()); }}
      onRetry={() => { void run(() => api.startCodexLogin()); }} />, actionsTarget)}
  </>;
}
