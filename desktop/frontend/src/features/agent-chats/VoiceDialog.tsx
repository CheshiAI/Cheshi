import { useEffect, useRef, useState } from 'react';
import { Modal, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { cheshiDesktop } from '../../cheshiDesktop';
import type { AgentVoiceApi, VoiceRequest, VoiceSnapshot } from '../../../../shared/agent-voice';
import styles from './VoiceDialog.module.css';

export function VoiceDialog({ roomId, onClose, api = cheshiDesktop?.agentVoice }: {
  roomId: string; onClose(): void; api?: AgentVoiceApi;
}) {
  const [state, setState] = useState<VoiceSnapshot | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), revision = useRef(0), alive = useRef(true);
  useEffect(() => {
    alive.current = true; let running = false;
    const refresh = async () => {
      if (!api || running) return; running = true; const version = ++revision.current;
      try { const next = await api.request({ action: 'status' }); if (alive.current && version === revision.current) setState(next); }
      catch (e) { if (alive.current && version === revision.current) setError(e instanceof Error ? e.message : 'Cannot load voice status.'); }
      finally { running = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { alive.current = false; revision.current++; clearInterval(timer); };
  }, [api]);
  const request = async (input: VoiceRequest) => {
    if (!api) return; setBusy(true); const version = ++revision.current;
    try { const next = await api.request(input); if (alive.current && version === revision.current) { setState(next); setError(null); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Voice request failed.'); }
    finally { if (alive.current) setBusy(false); }
  };
  return <Modal title="Phone calls" headerVariant="section" closeButtonVariant="ghost" onClose={onClose}>
    <div className={styles.content}>
      <p>Approve your phone to call this Mac and send spoken requests to this Chats room. Existing agent permissions still apply.</p>
      {!state?.configured && <p role="status">The connection service is not configured for this build.</p>}
      {state?.configured && <p role="status">{state.connected ? 'Connection service connected' : 'Connection service disconnected'}</p>}
      {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
      <NeumorphicButton variant="standard" disabled={busy || !state?.configured} onClick={() => { void request({ action: 'pair', roomId }); }}>Link a phone to this room</NeumorphicButton>
      {state?.link && <>
        <p>Open this temporary link on your phone, then compare the approval code on both devices. Keep the Mac running and connected to the internet.</p>
        <NeumorphicTextField variant="standard" readOnly aria-label="Phone pairing link" value={state.link} />
        <NeumorphicButton variant="standard" onClick={() => { void navigator.clipboard.writeText(state.link!).catch(() => setError('Select and copy the link manually.')); }}>Copy link</NeumorphicButton>
      </>}
      {state?.pending && <div className={styles.content}>
        <p>{state.pending.name} · Approval code: <strong>{state.pending.code}</strong></p>
        <div className={styles.actions}>
          <NeumorphicButton variant="standard" disabled={busy} onClick={() => { void request({ action: 'approve', id: state.pending!.id }); }}>Codes match · Approve</NeumorphicButton>
          <NeumorphicButton variant="ghost" disabled={busy} onClick={() => { void request({ action: 'reject', id: state.pending!.id }); }}>Reject</NeumorphicButton>
        </div>
      </div>}
      {state?.devices.map(device => <div key={device.id} className={styles.actions}><span>{device.name} · {device.roomName}</span>
        <NeumorphicButton variant="ghost" disabled={busy} onClick={() => { void request({ action: 'revoke', id: device.id }); }}>Unlink</NeumorphicButton></div>)}
      {state?.calling && <NeumorphicButton variant="standard" disabled={busy} onClick={() => { void request({ action: 'stop' }); }}>End call</NeumorphicButton>}
      <p>Ending a call keeps accepted Chats work running. Switching accounts removes phone approvals.</p>
    </div>
  </Modal>;
}
