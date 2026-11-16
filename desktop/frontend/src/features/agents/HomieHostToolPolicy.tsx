import { useEffect, useRef, useState } from 'react';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import type { AgentRegistryModel } from './agentRegistryModel';
import type { HostToolStatus } from '../../../../shared/host-tools';
import styles from './SpecialistAgentForm.module.css';

export function HomieHostToolPolicy({ model, agentId, tool, saved, disabled, onBusy, onChanged }: {
  model: AgentRegistryModel; agentId: string; tool: string; saved: boolean; disabled: boolean;
  onBusy(busy: boolean): void; onChanged(): void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), pending = useRef(false), revision = useRef(0);
  useEffect(() => {
    const current = ++revision.current;
    setEnabled(null); setError(''); setBusy(false);
    if (saved) void model.hostTool({ action: 'policy', agentId, tool }).then(value => {
      if (revision.current === current) setEnabled(policyValue(value));
    }).catch(cause => { if (revision.current === current) setError(String(cause)); });
    return () => { revision.current++; };
  }, [model, agentId, tool, saved]);
  const change = async (autoApprove: boolean) => {
    if (!saved || disabled || enabled === null || pending.current) return;
    pending.current = true; setBusy(true); onBusy(true); setError('');
    const current = revision.current;
    try {
      const value = await model.hostTool({ action: 'policy', agentId, tool, autoApprove });
      if (revision.current === current) { setEnabled(policyValue(value)); onChanged(); }
    } catch (cause) { if (revision.current === current) setError(String(cause)); }
    finally { pending.current = false; if (revision.current === current) setBusy(false); onBusy(false); }
  };
  return <>
    <div className={styles.switchRow}>
      <span>Automatically approve local tools</span>
      <ToggleSwitch aria-label="Automatically approve local tools" checked={enabled === true}
        disabled={disabled || busy || !saved || enabled === null} onChange={value => { void change(value); }} />
    </div>
    <p className={styles.description}>Only this Homie, project and account on this computer. After selecting each tool’s executable,
      new tool versions can run without confirmation, with your user access to files, devices and network services.
      Command permission and macOS privacy permissions still apply. Turning this off stops automatically approved calls and requires manual approval for those tools.</p>
    {!saved && <p className={styles.description}>Save local settings before changing automatic approval.</p>}
    {error && <p role="alert" className={styles.description}>{error}</p>}
  </>;
}

function policyValue(value: HostToolStatus) {
  if (typeof value.autoApprove !== 'boolean') throw new Error('Restart Cheshi to configure automatic approval.');
  return value.autoApprove;
}
