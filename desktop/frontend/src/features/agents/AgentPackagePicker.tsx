import { useEffect, useRef, useState } from 'react';
import type { AgentPackage } from '../../../../shared/agent-package';
import type { SpecialistProfile } from '../../../../shared/agent-registry';
import type { AgentRegistryModel } from './agentRegistryModel';
import { LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import styles from './SpecialistAgentForm.module.css';

export function AgentPackagePicker({ profile, model, existing, disabled, onBusy, onApply }: {
  profile: SpecialistProfile; model: AgentRegistryModel; existing: boolean; disabled: boolean;
  onBusy(busy: boolean): void;
  onApply(definition: AgentPackage, keepInstructions: boolean): void;
}) {
  const [packages, setPackages] = useState<AgentPackage[]>([]);
  const [candidate, setCandidate] = useState<AgentPackage | null>(null);
  const [keepInstructions, setKeepInstructions] = useState(existing);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void model.packages().then(values => { if (active.current) setPackages(values); }, reason => {
      if (active.current) setError(reason instanceof Error ? reason.message : 'Could not load packages.');
    });
    return () => { active.current = false; };
  }, [model]);
  const choose = (definition: AgentPackage) => {
    setError(null);
    if (profile.package && definition.id !== profile.package.id) {
      setError('Import a package with the same ID to update this Homie. Create a new Homie for a different package.');
      return;
    }
    setCandidate(definition);
    setKeepInstructions(existing && (!profile.package || profile.instructions !== profile.package.instructions));
  };
  const imported = candidate && !packages.some(item => item.id === candidate.id && item.version === candidate.version);
  return <section className={styles.field} aria-label="Agent package">
    <h3>Agent package</h3>
    {profile.package && <p className={styles.description}>
      {profile.package.id} · {profile.package.version} · {profile.instructions === profile.package.instructions ? 'Package instructions' : 'Customized instructions'}
    </p>}
    <LiquidGlassSelect ariaLabel="Official agent package" menuAppearance="toolbar" triggerAppearance="standard"
      value={candidate ? `${candidate.id}@${candidate.version}` : ''} disabled={disabled}
      options={[{ value: '', label: 'Official packages' }, ...packages.map(item => ({ value: `${item.id}@${item.version}`,
        label: `${item.name} · ${item.version}`, disabled: Boolean(profile.package && item.id !== profile.package.id) })),
      ...(imported ? [{ value: `${candidate.id}@${candidate.version}`, label: `${candidate.name} · ${candidate.version} (imported)` }] : [])]}
      onChange={value => {
        const definition = packages.find(item => `${item.id}@${item.version}` === value);
        if (definition) choose(definition); else if (!value) setCandidate(null);
      }} />
    <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => {
      onBusy(true); setError(null);
      void model.importPackage().then(definition => {
        if (active.current && definition) choose(definition);
      }, reason => {
        if (active.current) setError(reason instanceof Error ? reason.message : 'Could not import package.');
      }).finally(() => { if (active.current) onBusy(false); });
    }}>Import from file…</NeumorphicButton>
    {candidate && <div className={styles.field} aria-label="Package preview">
      <p className={styles.description}>{candidate.description}</p>
      <p className={styles.description}>{candidate.id} · {profile.package ? `${profile.package.version} → ` : ''}{candidate.version}</p>
      <p className={styles.description}>Default model: {candidate.model.model ?? 'Runtime default'} · {candidate.model.reasoningEffort ?? 'Model default'}</p>
      <p className={styles.description}>Required tools: {candidate.requiredTools.join(', ') || 'None'}</p>
      <p className={styles.description}>Requested permissions: {candidate.requestedPermissions.fileWrite ? 'Modify project files' : 'Read project files'} · {candidate.requestedPermissions.commandExecution ? 'Run commands' : 'No commands'}</p>
      {existing && profile.instructions !== candidate.instructions && <label className={styles.field}>Current instructions
        <NeumorphicTextField variant="standard" multiline readOnly rows={4} aria-label="Current package instructions" value={profile.instructions} />
      </label>}
      <label className={styles.field}>Package instructions
        <NeumorphicTextField variant="standard" multiline readOnly rows={6} aria-label="Package instructions preview" value={candidate.instructions} />
      </label>
      <div className={styles.switchRow}><span>Keep current instructions</span><ToggleSwitch aria-label="Keep current instructions"
        checked={keepInstructions} disabled={disabled} onChange={setKeepInstructions} /></div>
      <p className={styles.description}>{existing
        ? 'Your name, specialty, account, model, project settings and permissions are preserved. Save to apply; worker instructions update at the next Start.'
        : 'Loading fills this draft. Review the account, model and project permissions before creating your Homie.'}</p>
      <NeumorphicButton variant="standard" disabled={disabled} onClick={() => { onApply(candidate, keepInstructions); setCandidate(null); }}>
        {profile.package ? 'Apply package update to draft' : 'Load package into draft'}
      </NeumorphicButton>
      <NeumorphicButton variant="ghost" disabled={disabled} onClick={() => setCandidate(null)}>Cancel package preview</NeumorphicButton>
    </div>}
    {error && <p className={styles.description} role="alert">{error}</p>}
  </section>;
}
