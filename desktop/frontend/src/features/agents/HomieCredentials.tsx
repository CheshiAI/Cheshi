import { useEffect, useState } from 'react';
import type { AgentPackage } from '../../../../shared/agent-package';
import type { AgentRegistryModel } from './agentRegistryModel';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './SpecialistAgentForm.module.css';
import layout from './HomieSettings.module.css';

function Credential({ origin, name, model, disabled }: { origin: string; name: string; model: AgentRegistryModel; disabled: boolean }) {
  const [value, setValue] = useState(''), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false;
    void model.toolCredential({ origin, name, action: 'status' }).then(result => { if (!canceled) setSaved(result); }, () => { if (!canceled) setError('Cannot read credential status.'); });
    return () => { canceled = true; };
  }, [origin, name, model]);
  const change = async (action: 'save' | 'remove') => {
    if (busy || disabled) return;
    setBusy(true); setError(null);
    try { await model.toolCredential({ origin, name, action, ...(action === 'save' ? { value } : {}) }); setSaved(action === 'save'); setValue(''); }
    catch { setError('Could not update credential.'); }
    finally { setBusy(false); }
  };
  return <div className={layout.section}>
    <label className={styles.field}>{name} · {origin}<NeumorphicTextField variant="standard" type="password" aria-label={`Credential ${name}`} autoComplete="off" value={value} disabled={disabled || busy} onChange={e => setValue(e.target.value)} /></label>
    <p className={styles.description}>{saved ? 'Credential saved locally.' : 'No credential saved.'}</p>
    <div className={layout.actions}><NeumorphicButton variant="standard" disabled={disabled || busy || !value.trim()} onClick={() => { void change('save'); }}>Save credential</NeumorphicButton>
      <NeumorphicButton variant="ghost" disabled={disabled || busy || !saved} onClick={() => { void change('remove'); }}>Remove credential</NeumorphicButton></div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
export function HomieCredentials({ pack, model, disabled }: { pack?: AgentPackage; model: AgentRegistryModel; disabled: boolean }) {
  const entries = new Map<string, { origin: string; name: string }>();
  for (const tool of pack?.tools ?? []) if (tool.network?.credential) {
    const entry = { origin: new URL(tool.network.url).origin, name: tool.network.credential };
    entries.set(`${entry.origin}/${entry.name}`, entry);
  }
  return entries.size ? <section className={layout.section}><h3>Local tool credentials</h3>
    <p className={styles.description}>Credentials stay on this computer and are never written to the Homie repository.</p>
    {[...entries].map(([key, entry]) => <Credential key={key} {...entry} model={model} disabled={disabled} />)}</section> : null;
}
