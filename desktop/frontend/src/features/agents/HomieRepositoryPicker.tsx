import { useEffect, useRef, useState } from 'react';
import type { HomieRepositoryPreview } from '../../../../shared/homie-repository-connection';
import type { AgentRegistryModel } from './agentRegistryModel';
import { LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './SpecialistAgentForm.module.css';
import layout from './HomieSettings.module.css';

export function HomieRepositoryPicker({ model, existing, url, preview, disabled, onMode, onUrl, onPreview, onBusy }: {
  model: AgentRegistryModel; existing: boolean; url: string; preview?: HomieRepositoryPreview;
  disabled: boolean; onMode(value: boolean): void; onUrl(value: string): void;
  onPreview(value: HomieRepositoryPreview | undefined): void; onBusy(value: boolean): void;
}) {
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const active = useRef(true), operation = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const check = async () => {
    if (disabled || operation.current || !url.trim()) return;
    operation.current = true; setPending(true); onBusy(true); setError(null); onPreview(undefined);
    try {
      const result = await model.previewRepository(url);
      if (active.current) onPreview(result);
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Could not check the repository.'); }
    finally { operation.current = false; if (active.current) { setPending(false); onBusy(false); } }
  };
  return <section className={layout.section} aria-label="Homie source">
    <label className={styles.field}>Homie source<LiquidGlassSelect ariaLabel="Homie source" value={existing ? 'existing' : 'new'} disabled={disabled}
      menuAppearance="toolbar" triggerAppearance="standard"
      options={[{ value: 'new', label: 'Create a new Homie' }, { value: 'existing', label: 'Connect an existing GitHub Homie' }]}
      onChange={value => { setError(null); onMode(value === 'existing'); }} /></label>
    {existing && <>
      <label className={styles.field}>GitHub repository<NeumorphicTextField variant="standard" aria-label="Homie GitHub repository"
        placeholder="https://github.com/owner/Homie-name" value={url} disabled={disabled}
        onChange={event => { setError(null); onUrl(event.target.value); onPreview(undefined); }} /></label>
      <p className={styles.description}>Check downloads a local checkout or reuses the matching folder in Developments. Existing local files and Git history are kept.</p>
      <NeumorphicButton type="button" variant="standard" disabled={disabled || !url.trim()} onClick={() => void check()}>
        {pending ? 'Checking repository…' : 'Check repository'}
      </NeumorphicButton>
      {pending && <p role="status" className={styles.description}>Checking GitHub access, preparing the checkout and validating Homie files…</p>}
      {preview && <div className={layout.section} role="status">
        <p className={styles.description}>{preview.definition.name} · {preview.definition.version} — {preview.definition.description}</p>
        <p className={styles.description}>{preview.directory}</p>
        <p className={styles.description}>Repository checked. Select a local account, project assignment and permissions below. The repository model is preserved; change it in Homie settings after connecting.</p>
      </div>}
      {error && <p role="alert" className={styles.description}>{error}</p>}
    </>}
  </section>;
}
