import { useEffect, useRef, useState } from 'react';
import { NeumorphicButton } from '../../shared/ui';
import type { AgentRegistryModel } from './agentRegistryModel';
import type { HostToolStatus } from '../../../../shared/host-tools';
import { HomieHostToolDetails } from './HomieHostToolDetails';

export function HomieHostTool({ model, agentId, tool, runtime, reviewKey, saved, disabled, onBusy }: {
  model: AgentRegistryModel; agentId?: string; tool: string; runtime?: string; reviewKey?: string; saved: boolean; disabled: boolean; onBusy(value: boolean): void;
}) {
  const [state, setState] = useState<HostToolStatus | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), running = useRef(false);
  const [details, setDetails] = useState<string | null>(null);
  const finishDetails = useRef<((back: boolean) => void) | null>(null);
  const closeDetails = (back: boolean) => {
    const finish = finishDetails.current;
    finishDetails.current = null;
    setDetails(null);
    finish?.(back);
  };
  useEffect(() => {
    const unsubscribe = model.onHostToolDetails(review => {
      if (!running.current || review.agentId !== agentId || review.tool !== tool) return;
      finishDetails.current?.(false);
      setDetails(review.text);
      return new Promise<boolean>(resolve => { finishDetails.current = resolve; });
    });
    return () => {
      unsubscribe();
      finishDetails.current?.(false);
      finishDetails.current = null;
    };
  }, [model, agentId, tool]);
  useEffect(() => {
    let canceled = false; setState(null); setError('');
    if (agentId && saved) void model.hostTool({ action: 'status', agentId, tool }).then(value => {
      if (!canceled) setState(value);
    }, reason => { if (!canceled) setError(String(reason)); });
    return () => { canceled = true; };
  }, [model, agentId, tool, reviewKey, saved]);
  const act = async (action: 'allow' | 'revoke') => {
    if (!agentId || running.current) return;
    running.current = true; setBusy(true); onBusy(true); setError('');
    try { setState(await model.hostTool({ action, agentId, tool })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Host tool review failed.'); }
    finally { closeDetails(false); running.current = false; setBusy(false); onBusy(false); }
  };
  return <div>
    <p>This tool runs on this computer with your user permissions. Local approval is separate from command permission and is excluded from exports.</p>
    <p role="status">{!saved ? 'Save the tool before reviewing local access.' : state?.allowed ? 'Host tool allowed for this project and account.' : 'Host tool needs local approval.'}</p>
    {runtime === 'python3' && <p>Cheshi prepares and manages Python for this tool. No separate Python installation or executable selection is needed. First preparation requires a download.</p>}
    {busy && <p role="status">Preparing runtime and reviewing host access…</p>}
    {state?.autoApprove && <p>Automatic approval is on. Later tool versions can reuse the configured runtime without confirmation.</p>}
    {state?.executable && <p>Executable: {state.executable}</p>}
    <NeumorphicButton variant="ghost" disabled={disabled || busy || !saved || !agentId} onClick={() => { void act('allow'); }}>{state?.autoApprove ? 'Configure host access…' : 'Review host access…'}</NeumorphicButton>
    <NeumorphicButton variant="ghost" disabled={busy || !agentId || !state?.executable} onClick={() => { void act('revoke'); }}>Revoke host access</NeumorphicButton>
    {error && <p role="alert">{error}</p>}
    {details !== null && <HomieHostToolDetails text={details} onClose={closeDetails} />}
  </div>;
}
