import { ArrowUp, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CODEX_UPDATE_STAGE_LABELS, CODEX_UPDATE_STALE_MS, codexUpdateDetail, newerCodexVersion, type CodexUpdateApi, type CodexUpdateState } from '../../../../shared/codex-update';
import { cheshiDesktop } from '../../cheshiDesktop';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import styles from './CodexUpdateIndicator.module.css';

export function CodexUpdateIndicator({ api = cheshiDesktop }: { api?: Partial<CodexUpdateApi> }) {
  const [state, setState] = useState<CodexUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const busy = requesting || state?.busy === true;
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (!api?.getCodexUpdate || !api.onCodexUpdateChanged) return;
    let active = true, revision = -1;
    const receive = (value: CodexUpdateState) => {
      if (!active || value.revision < revision) return;
      revision = value.revision; setState(value); setError(null);
    };
    const unsubscribe = api.onCodexUpdateChanged(receive);
    void api.getCodexUpdate().then(receive).catch(() => { if (active) setError('Codex status unavailable. Click to retry.'); });
    return () => { active = false; unsubscribe(); };
  }, [api]);
  if (!api?.getCodexUpdate) return null;
  const available = !!state?.installedVersion && !!state.availableVersion && newerCodexVersion(state.availableVersion, state.installedVersion);
  const pending = (state?.workers.pending ?? 0) > 0;
  const action = available && state?.managed ? 'Update Codex and workers' : pending ? 'Update workers' : 'Check for updates';
  const failure = error ?? state?.error;
  const progress = state?.busy ? state.progress : null;
  const startedAt = progress?.startedAt ?? requestedAt ?? now;
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const quiet = Math.max(0, Math.floor((now - (progress?.updatedAt ?? startedAt)) / 1000));
  const delayed = busy && quiet * 1000 >= CODEX_UPDATE_STALE_MS;
  const stage = progress ? CODEX_UPDATE_STAGE_LABELS[progress.stage]
    : state?.busy && state.phase === 'workers' ? 'Updating workers…' : 'Checking versions…';
  const timing = busy ? `Elapsed: ${elapsed}s · Last progress: ${quiet}s ago` : '';
  const detail = busy ? [stage, timing,
    delayed ? 'No new progress reported for 60s or longer. Still waiting for a result; this does not confirm a failure.' : '',
    state?.workers.versions.length ? `Workers: ${state.workers.versions.join(', ')}` : '',
  ].filter(Boolean).join(' · ')
    : [failure || (state ? codexUpdateDetail(state) : ''), available ? `Available: ${state?.availableVersion}.` : '',
      `Click to ${action.toLowerCase()}.`].filter(Boolean).join(' ');
  const suffix = busy ? `${stage} ${elapsed}s${delayed ? ' · Taking longer than expected' : ''}`
    : failure ? 'Retry' : state?.workers.waiting ? 'Waiting for active tasks' : pending ? 'Workers pending' : null;
  async function activate() {
    setRequestedAt(Date.now()); setRequesting(true); setError(null);
    try {
      const next = available && state?.managed ? await api?.installCodexUpdate?.()
        : pending ? await api?.syncWorkerCodex?.() : await api?.checkCodexUpdate?.();
      if (next) setState(previous => !previous || next.revision >= previous.revision ? next : previous);
    } catch { setError('Codex update unavailable. Click to retry.'); }
    finally { setRequesting(false); setRequestedAt(null); }
  }
  return <TooltipTarget content={detail || 'Checking Codex…'}>
    <button type="button" className={styles.button} disabled={busy} aria-label={`${action} · Codex CLI ${state?.installedVersion ?? 'unknown'}`}
      aria-busy={busy} data-delayed={delayed || undefined} data-attention={!!failure || available || pending || undefined} onClick={() => { void activate(); }}>
      <span>Codex CLI {state?.installedVersion ?? '…'}</span>
      {busy ? <RefreshCw className={styles.spinner} aria-hidden="true" /> : available && state?.managed ? <ArrowUp aria-hidden="true" /> : null}
      {suffix && <span>· {suffix}</span>}
    </button>
  </TooltipTarget>;
}
