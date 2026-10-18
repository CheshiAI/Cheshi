import { useEffect, useRef, useState } from 'react';
import { parseHomieRepository, parseHomieRepositoryDirectory, type HomieRepositoryPreview } from '../../../../shared/homie-repository-connection';
import type { AgentRegistryModel } from './agentRegistryModel';
import { LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import styles from './SpecialistAgentForm.module.css';
import layout from './HomieSettings.module.css';

export function HomieRepositoryPicker({ model, existing, url, directory, preview, disabled, onMode, onUrl, onDirectory, onPreview, onBusy }: {
  model: AgentRegistryModel; existing: boolean; url: string; directory?: string; preview?: HomieRepositoryPreview;
  disabled: boolean; onMode(value: boolean): void; onUrl(value: string): void;
  onDirectory(value: string | undefined): void;
  onPreview(value: HomieRepositoryPreview | undefined): void; onBusy(value: boolean): void;
}) {
  const [pending, setPending] = useState<'check' | 'choose' | null>(null), [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ repository: string; directory: string } | null>(null);
  const active = useRef(true), operation = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  let repository = '';
  try { repository = parseHomieRepository(url); } catch { /* Wait for a complete GitHub repository. */ }
  const location = directory ?? (preview?.repository === repository ? preview.directory : undefined)
    ?? (suggestion?.repository === repository ? suggestion.directory : '');
  useEffect(() => {
    if (!existing || !repository || directory !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await model.repositoryLocation({ repository });
        if (!cancelled && result !== null) setSuggestion({ repository, directory: result });
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not suggest a save location.'); }
    })();
    return () => { cancelled = true; };
  }, [existing, repository, directory, model]);
  const changeDirectory = (value: string | undefined) => { setError(null); onDirectory(value); onPreview(undefined); };
  const choose = async () => {
    if (disabled || operation.current || !repository) return;
    operation.current = true; setPending('choose'); onBusy(true); setError(null);
    try {
      const result = await model.repositoryLocation({ repository, ...(location ? { directory: location } : {}), choose: true });
      if (active.current && result !== null) changeDirectory(result);
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Could not choose a save location.'); }
    finally { operation.current = false; if (active.current) { setPending(null); onBusy(false); } }
  };
  const check = async () => {
    if (disabled || operation.current || !repository || !location) return;
    operation.current = true; setPending('check'); onBusy(true); setError(null); onPreview(undefined);
    try {
      const result = await model.previewRepository(repository, parseHomieRepositoryDirectory(location));
      if (active.current) { onDirectory(result.directory); onPreview(result); }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Could not check the repository.'); }
    finally { operation.current = false; if (active.current) { setPending(null); onBusy(false); } }
  };
  return <section className={layout.section} aria-label="Homie source">
    <label className={styles.field}>Homie source<LiquidGlassSelect ariaLabel="Homie source" value={existing ? 'existing' : 'new'} disabled={disabled}
      menuAppearance="toolbar" triggerAppearance="standard"
      options={[{ value: 'new', label: 'Create a new Homie' }, { value: 'existing', label: 'Connect an existing GitHub Homie' }]}
      onChange={value => { setError(null); onMode(value === 'existing'); }} /></label>
    {existing && <>
      <label className={styles.field}>GitHub repository<NeumorphicTextField variant="standard" aria-label="Homie GitHub repository"
        placeholder="https://github.com/owner/Homie-name" value={url} disabled={disabled}
        onChange={event => { setError(null); onUrl(event.target.value); onDirectory(undefined); onPreview(undefined); }} /></label>
      <label className={styles.field}>Save location<NeumorphicTextField variant="standard" aria-label="Homie repository save location"
        placeholder="Enter a GitHub repository to see its suggested location" value={location} disabled={disabled}
        onChange={event => changeDirectory(event.target.value)} /></label>
      <NeumorphicButton type="button" variant="ghost" disabled={disabled || !repository} onClick={() => void choose()}>
        {pending === 'choose' ? 'Choosing folder…' : 'Choose parent folder'}
      </NeumorphicButton>
      <p className={styles.description}>Choose a parent folder or enter the full repository folder path. Check downloads to this location or reuses its matching checkout. Existing files and Git history are kept. Connecting adds the repository to this Explorer.</p>
      <NeumorphicButton type="button" variant="standard" disabled={disabled || !repository || !location} onClick={() => void check()}>
        {pending === 'check' ? 'Checking repository…' : 'Check repository'}
      </NeumorphicButton>
      {pending === 'check' && <p role="status" className={styles.description}>Checking GitHub access, preparing the checkout and validating Homie files…</p>}
      {preview && <div className={layout.section} role="status">
        <p className={styles.description}>{preview.definition.name} · {preview.definition.version} — {preview.definition.description}</p>
        <p className={styles.description}>{preview.directory}</p>
        <p className={styles.description}>Repository checked. Select a local account, project assignment and permissions below. The repository model is preserved; change it in Homie settings after connecting.</p>
      </div>}
      {error && <p role="alert" className={styles.description}>{error}</p>}
    </>}
  </section>;
}
