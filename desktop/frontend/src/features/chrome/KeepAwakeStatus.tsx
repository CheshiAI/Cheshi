import { Coffee } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { KeepAwakeApi, KeepAwakeState } from '../../../../shared/keep-awake';
import { cheshiDesktop } from '../../cheshiDesktop';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import styles from './KeepAwakeStatus.module.css';

export function KeepAwakeStatus({ api = cheshiDesktop }: {
  api?: Partial<KeepAwakeApi> & { platform: string };
}) {
  const [state, setState] = useState<KeepAwakeState | null>(null);
  const [failed, setFailed] = useState(false);
  const available = api?.platform === 'darwin' && !!api.getKeepAwake && !!api.onKeepAwakeChanged;
  useEffect(() => {
    setState(null); setFailed(false);
    if (!available) return;
    let disposed = false, revision = -1;
    const receive = (next: KeepAwakeState) => {
      if (disposed || next.revision < revision) return;
      revision = next.revision;
      setState(next); setFailed(false);
    };
    const unsubscribe = api.onKeepAwakeChanged!(receive);
    void api.getKeepAwake!().then(receive).catch(() => {
      if (!disposed && revision < 0) setFailed(true);
    });
    return () => { disposed = true; unsubscribe(); };
  }, [api, available]);

  if (!available || state?.supported === false) return null;
  const unavailable = failed || Boolean(state?.error);
  const pending = !unavailable && (!state || state.busy);
  const enabled = !unavailable && !pending && state?.enabled === true;
  const label = unavailable ? '?' : pending ? '…' : enabled ? 'ON' : 'OFF';
  const description = unavailable ? 'Caffeine mode status unavailable.'
    : pending ? (state ? 'Updating caffeine mode…' : 'Checking caffeine mode…')
    : enabled ? 'Caffeine mode on · Your Mac will stay awake.'
    : 'Caffeine mode off · Your Mac can sleep normally.';
  return <TooltipTarget content={description}>
    <span className={styles.status} role="status" aria-label={description} aria-atomic="true" tabIndex={0}
      data-enabled={enabled ? 'true' : undefined}>
      <Coffee aria-hidden="true" /><span>{label}</span>
    </span>
  </TooltipTarget>;
}
