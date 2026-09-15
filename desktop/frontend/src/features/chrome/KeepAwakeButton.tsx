import { Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeepAwakeApi, KeepAwakeState } from '../../../../shared/keep-awake';
import { cheshiDesktop } from '../../cheshiDesktop';
import { NeumorphicButton, nonDraggableWindowRegionStyle } from '../../shared/ui';
import { useHelpLanguage } from '../../shared/useHelpLanguage';

export function KeepAwakeButton({ api = cheshiDesktop }: { api?: Partial<KeepAwakeApi> & { platform: string } }) {
  const [language] = useHelpLanguage();
  const [state, setState] = useState<KeepAwakeState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(-1);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const available = api?.platform === 'darwin' && !!api.getKeepAwake && !!api.setKeepAwake && !!api.onKeepAwakeChanged;
  const receive = (next: KeepAwakeState) => {
    if (!alive.current || next.revision < revision.current) return;
    revision.current = next.revision;
    setState(next);
    setError(next.error);
  };

  useEffect(() => {
    if (!available) return;
    alive.current = true;
    const unsubscribe = api.onKeepAwakeChanged!(receive);
    void api.getKeepAwake!().then(receive).catch((reason: unknown) => {
      if (alive.current && revision.current < 0) setError(String(reason));
    });
    return () => { alive.current = false; unsubscribe(); };
  }, [api, available]);

  if (!available || state?.supported === false) return null;
  const enabled = state?.enabled === true;
  const busy = pending || state?.busy === true || (!state && !error);
  const label = language === 'ko'
    ? (!state && error ? '절전 방지 상태 다시 확인' : enabled ? '절전 방지 종료' : '절전 방지 실행')
    : (!state && error ? 'Retry keep awake status' : enabled ? 'Stop keeping awake' : 'Keep awake');
  const title = error ? `${label}: ${error}` : label;
  const toggle = async () => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try { receive(await (state ? api.setKeepAwake!(!enabled) : api.getKeepAwake!())); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  };
  return <NeumorphicButton raised size="icon" style={nonDraggableWindowRegionStyle}
    title={title} aria-label={title} aria-pressed={enabled} aria-busy={busy} disabled={busy}
    onClick={() => { void toggle(); }}>
    {enabled ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
  </NeumorphicButton>;
}
