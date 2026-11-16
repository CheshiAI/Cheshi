import { useEffect, useRef, useState } from 'react';
import { NeumorphicButton } from '../../shared/ui';
import type { AgentRegistryModel } from './agentRegistryModel';
import type { HostToolStatus } from '../../../../shared/host-tools';
import { HomieHostToolDetails } from './HomieHostToolDetails';
import layout from './HomieSettings.module.css';
import { hostToolPresentation } from './hostToolPresentation';

export function HomieHostTool({ model, agentId, tool, runtime, reviewKey, saved, disabled, onBusy }: {
  model: AgentRegistryModel; agentId?: string; tool: string; runtime?: string; reviewKey?: string; saved: boolean; disabled: boolean; onBusy(value: boolean): void;
}) {
  const [state, setState] = useState<HostToolStatus | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), running = useRef(false);
  const [details, setDetails] = useState<string | null>(null);
  const [approvalInfoOpen, setApprovalInfoOpen] = useState(false);
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
  useEffect(() => {
    if (!busy || !agentId) return;
    let canceled = false, pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void model.hostTool({ action: 'status', agentId, tool }).then(value => {
        if (!canceled) setState(value);
      }).catch(() => {}).finally(() => { pending = false; });
    }, 1000);
    return () => { canceled = true; clearInterval(timer); };
  }, [busy, agentId, model, tool]);
  const act = async (action: 'allow' | 'revoke') => {
    if (!agentId || running.current) return;
    running.current = true; setBusy(true); onBusy(true); setError('');
    try { setState(await model.hostTool({ action, agentId, tool })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Host tool review failed.'); }
    finally { closeDetails(false); running.current = false; setBusy(false); onBusy(false); }
  };
  const presentation = hostToolPresentation(state, saved);
  return <div>
    <p>This tool runs on this computer with your user permissions. Local approval is separate from command permission and is excluded from exports.</p>
    <div role="status">
      <p className="section-title">{busy ? 'Preparing access…' : presentation.title}</p>
      <p className="description">{busy ? state?.preparation ?? 'Preparing runtime and reviewing host access…' : presentation.description}</p>
    </div>
    {runtime === 'python3' && <p>Cheshi prepares and manages Python for this tool. No separate Python installation or executable selection is needed. First preparation requires a download.</p>}
    {state?.autoApprove && <p>Automatic approval is on. Later tool versions can reuse the configured runtime without confirmation.</p>}
    {state?.executable && <p>Executable: {state.executable}</p>}
    <div className={layout.saveActions} role="group" aria-label={`${tool} host access`}>
      <NeumorphicButton variant="ghost" disabled={disabled || busy || !saved || !agentId || !state}
        onClick={() => { if (presentation.details) setApprovalInfoOpen(true); else void act('allow'); }}>{presentation.action}</NeumorphicButton>
      <NeumorphicButton variant="ghost" disabled={busy || !agentId || !state?.executable} onClick={() => { void act('revoke'); }}>Revoke host access</NeumorphicButton>
    </div>
    {error && <p role="alert">{error}</p>}
    {details !== null && <HomieHostToolDetails text={details} onClose={closeDetails} />}
    {approvalInfoOpen && <HomieHostToolDetails mode="approval" text={state?.approvalDetails
      ?? `Executable: ${state?.executable ?? 'Unavailable'}\nApproved package SHA-256: ${state?.digest ?? 'Unavailable'}`}
      onClose={() => setApprovalInfoOpen(false)} />}
  </div>;
}
