import { CirclePlay, CircleStop } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeepAwakeApi, KeepAwakeState } from '../../../../shared/keep-awake';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LiquidGlassPanel, NeumorphicButton, nonDraggableWindowRegionStyle } from '../../shared/ui';
import styles from './KeepAwakeToggle.module.css';

export function KeepAwakeToggle({ api = cheshiDesktop?.keepAwake }: { api?: KeepAwakeApi }) {
  const [state, setState] = useState<KeepAwakeState>({ supported: false, enabled: false, error: null });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const lifecycle = useRef({ mounted: false, revision: 0, pending: false });
  const errorId = useId();

  useEffect(() => {
    const current = { mounted: true, revision: 0, pending: false };
    lifecycle.current = current;
    setLoading(true);
    setPending(false);
    if (!api) {
      setState({ supported: false, enabled: false, error: null });
      setLoading(false);
      return () => { current.mounted = false; };
    }
    const unsubscribe = api.subscribe(value => {
      if (!current.mounted) return;
      current.revision++;
      setState(value);
      setLoading(false);
    });
    const revision = current.revision;
    void api.get().then(value => {
      if (current.mounted && current.revision === revision) setState(value);
    }).catch(error => {
      if (current.mounted && current.revision === revision) {
        setState({ supported: false, enabled: false, error: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => { if (current.mounted) setLoading(false); });
    return () => { current.mounted = false; unsubscribe(); };
  }, [api]);

  const toggle = async () => {
    const current = lifecycle.current;
    if (!api || !current.mounted || current.pending || loading || !state.supported) return;
    current.pending = true;
    setPending(true);
    const revision = current.revision;
    try {
      const next = await api.set(!state.enabled);
      if (current.mounted && current.revision === revision) setState(next);
    } catch (error) {
      if (current.mounted && current.revision === revision) {
        setState({ ...state, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      current.pending = false;
      if (current.mounted) setPending(false);
    }
  };

  const label = state.enabled ? 'Stop keeping awake' : 'Keep display and system awake';
  const title = loading ? 'Checking keep-awake status'
    : !state.supported ? 'Keep awake is available on macOS'
    : `${label} (caffeinate -d -i)`;
  const Icon = state.enabled ? CircleStop : CirclePlay;
  return <span className={styles.toggle} style={nonDraggableWindowRegionStyle}>
    <NeumorphicButton raised size="icon" aria-label={label} aria-pressed={state.enabled}
      aria-describedby={state.error ? errorId : undefined} title={state.error ? `${title}: ${state.error}` : title}
      disabled={loading || pending || !state.supported} onClick={() => { void toggle(); }}>
      <Icon aria-hidden="true" />
    </NeumorphicButton>
    {state.error && <LiquidGlassPanel className={styles.error} id={errorId} role="alert">
      {state.error}
    </LiquidGlassPanel>}
  </span>;
}
