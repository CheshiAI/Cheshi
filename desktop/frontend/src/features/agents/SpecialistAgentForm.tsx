import { ArrowLeft } from 'lucide-react';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { defaultAgentAvatar, randomAgentAvatar } from '../../../../shared/agent-avatar';
import { AgentAvatarPicker } from './AgentAvatarPicker';
import { InstructionFiles } from './InstructionFiles';
import { useEffect, useRef, useState } from 'react';
import type { AgentRegistryState, AgentRegistryModel } from './agentRegistryModel';
import type { SpecialistAgent, SpecialistProfile } from '../../../../shared/agent-registry';
import { EXECUTION_PRESETS, SPECIALIST_ROLES } from '../../../../shared/agent-registry';
import type { CodexAccountsApi, CodexAccountProfile } from '../../../../shared/codex-accounts';
import { LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { specialistTemplates } from './specialistTemplates';
import styles from './SpecialistAgentForm.module.css';
import { SpecialistModelSettings, useSpecialistModels } from './SpecialistModelSettings';
import { assertAgentModelSelection } from '../../../../shared/agent-models';

function initialProfile(agent?: SpecialistAgent): SpecialistProfile {
  return agent ? { avatar: agent.avatar ?? defaultAgentAvatar(agent.id), name: agent.name, role: agent.role, instructions: agent.instructions,
    instructionFiles: agent.instructionFiles ?? [], accountId: agent.accountId, model: agent.model, reasoningEffort: agent.reasoningEffort, serviceTier: agent.serviceTier,
    permissions: { ...agent.permissions } } : {
    avatar: randomAgentAvatar(), name: '', role: 'development', instructions: specialistTemplates.development.instructions,
    accountId: null, model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false },
  };
}

export function SpecialistAgentForm({ agent, model, state, accountsApi, onBack, onAdvanced }: {
  onBack?: () => void; onAdvanced?: () => void;
  agent?: SpecialistAgent; model: AgentRegistryModel; state: AgentRegistryState;
  accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const workspaceRoot = state.data!.workspaceRoot;
  const assignment = agent?.assignments.find(item => item.workspaceRoot === workspaceRoot);
  const [profile, setProfile] = useState(() => initialProfile(agent));
  const [permissions, setPermissions] = useState(assignment?.permissions ?? agent?.permissions ?? EXECUTION_PRESETS.development);
  const [revision, setRevision] = useState(agent?.revision ?? null);
  const [assigned, setAssigned] = useState(agent ? Boolean(assignment) : true);
  const [instructions, setInstructions] = useState(assignment?.instructions ?? '');
  const [instructionFiles, setInstructionFiles] = useState(assignment?.instructionFiles ?? []);
  const [filePending, setFilePending] = useState(false);
  const disabled = state.saving || filePending;
  const [accounts, setAccounts] = useState<CodexAccountProfile[]>([]);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const active = useRef(true);
  const scrollbar = useAutoHideScrollbars<HTMLFormElement>();
  const catalog = useSpecialistModels(profile.accountId, model.models);
  let modelError: string | null = null;
  try { assertAgentModelSelection(profile, catalog.models); }
  catch (error) { modelError = error instanceof Error ? error.message : 'Invalid model settings.'; }
  const modelBlocked = profile.model !== null && (catalog.loading || Boolean(catalog.error) || Boolean(modelError));
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!accountsApi) return;
    let disposed = false, changed = false;
    const unsubscribe = accountsApi.onDidChange(snapshot => {
      changed = true;
      if (!disposed) { setAccounts(snapshot.profiles); setAccountError(null); }
    });
    void accountsApi.list().then(snapshot => {
      if (!disposed && !changed) setAccounts(snapshot.profiles);
    }, () => { if (!disposed && !changed) setAccountError('Could not load accounts. You can configure one later.'); });
    return () => { disposed = true; unsubscribe(); };
  }, [accountsApi]);
  const patch = (value: Partial<SpecialistProfile>) => { setProfile(current => ({ ...current, ...value })); setSaved(false); };
  const accountOptions = [{ value: '', label: 'Configure later' }, ...accounts.map(account => ({
    value: account.id, label: `${account.email || account.label || account.id}${account.usage.authenticated ? '' : ' (sign-in required)'}`,
  }))];
  if (profile.accountId && !accounts.some(account => account.id === profile.accountId)) {
    accountOptions.push({ value: profile.accountId, label: `${profile.accountId} (unavailable)` });
  }
  const outdated = agent && revision !== agent.revision;
  return <form ref={scrollbar} className={styles.form} aria-label={agent ? 'Agent settings' : 'Create agent'} onSubmit={event => {
    event.preventDefault();
    if (modelBlocked || disabled) return;
    void model.save({ id: agent?.id ?? null, revision, profile,
      assignment: { assigned, instructions, instructionFiles, permissions } }).then(result => {
      if (active.current) { setRevision(result.revision); setSaved(true); }
    }, () => { /* The model exposes the error without discarding the draft. */ });
  }}>
    <div className={styles.heading}>
      {onBack && <TooltipButton variant="ghost" size="icon" aria-label="All Homies" title="All Homies"
        disabled={disabled} onClick={onBack}><ArrowLeft aria-hidden="true" /></TooltipButton>}
      <h2>{agent ? agent.name : 'Create agent'}</h2>
      {onAdvanced && <NeumorphicButton variant="ghost" disabled={disabled} onClick={onAdvanced}>Advanced</NeumorphicButton>}
      {!agent && <span>Cheshi-wide agent</span>}
    </div>
    <fieldset disabled={disabled} className={styles.fields}>
      <AgentAvatarPicker value={profile.avatar!} disabled={state.saving} onChange={avatar => patch({ avatar })} />
      <label className={styles.field}>Name<NeumorphicTextField variant="standard" aria-label="Agent name" required maxLength={100}
        value={profile.name} onChange={event => patch({ name: event.target.value })} /></label>
      <div className={styles.field}><span>Specialty</span><LiquidGlassSelect ariaLabel="Agent specialty" menuAppearance="toolbar" triggerAppearance="standard"
        value={profile.role} disabled={state.saving} options={SPECIALIST_ROLES.map(value => ({ value, label: specialistTemplates[value].label }))}
        onChange={role => {
          patch({ role, instructions: profile.instructions === specialistTemplates[profile.role].instructions ? specialistTemplates[role].instructions : profile.instructions });
          if (!agent) setPermissions({ ...EXECUTION_PRESETS[role === 'verification' ? 'verification' : role === 'development' || role === 'frontend' ? 'development' : 'review'] });
        }} /></div>
      <label className={styles.field}>Instructions<NeumorphicTextField variant="standard" multiline rows={5} aria-label="Agent instructions"
        required maxLength={20_000} value={profile.instructions} onChange={event => patch({ instructions: event.target.value })} /></label>
      <InstructionFiles label="Common instruction files" paths={profile.instructionFiles ?? []} model={model} disabled={disabled}
        onBusy={setFilePending} onChange={instructionFiles => patch({ instructionFiles })} />
      <div className={styles.field}><span>Account</span><LiquidGlassSelect ariaLabel="Agent account" menuAppearance="toolbar" triggerAppearance="standard"
        options={accountOptions} value={profile.accountId ?? ''} disabled={state.saving}
        onChange={accountId => patch({ accountId: accountId || null, model: null, reasoningEffort: null, serviceTier: null })} /></div>
      {accountError && <p role="status" className={styles.description}>{accountError}</p>}
      <SpecialistModelSettings selection={profile} catalog={catalog} disabled={state.saving} onChange={patch} />
      {modelError && !catalog.loading && !catalog.error && <p className={styles.description} role="alert">{modelError}</p>}
      <div className={styles.field}><h3>Execution permissions</h3>
        <p className={styles.description}>Applies to this project. Choose permissions before starting the worker. Changing them later replaces its idle container and preserves conversations. Command access prepares Linux dependencies before work.</p>
        <LiquidGlassSelect ariaLabel="Execution permission preset" menuAppearance="toolbar" triggerAppearance="standard"
          value={Object.entries(EXECUTION_PRESETS).find(([, p]) => p.fileWrite === permissions.fileWrite && p.commandExecution === permissions.commandExecution)?.[0] ?? 'custom'}
          disabled={disabled} options={[{ value: 'development', label: 'Development · Files and commands' }, { value: 'verification', label: 'Verification · Commands only' }, { value: 'review', label: 'Review · Read only' }, { value: 'custom', label: 'Custom' }]}
          onChange={value => { if (value in EXECUTION_PRESETS) { setPermissions({ ...EXECUTION_PRESETS[value as keyof typeof EXECUTION_PRESETS] }); setSaved(false); } }} />
        <div className={styles.switchRow}><span>Modify project files</span><ToggleSwitch aria-label="Allow agent file changes" checked={permissions.fileWrite}
          disabled={state.saving} onChange={fileWrite => { setPermissions({ ...permissions, fileWrite }); setSaved(false); }} /></div>
        <div className={styles.switchRow}><span>Run commands</span><ToggleSwitch aria-label="Allow agent commands" checked={permissions.commandExecution}
          disabled={state.saving} onChange={commandExecution => { setPermissions({ ...permissions, commandExecution }); setSaved(false); }} /></div>
      </div>
      <div className={styles.field}><h3>Project assignment</h3>
        <p className={styles.description}>{workspaceRoot}</p>
        <div className={styles.switchRow}><span>Assign to this project</span><ToggleSwitch aria-label="Assign agent to this project" checked={assigned}
          disabled={state.saving} onChange={value => { setAssigned(value); setSaved(false); }} /></div>
        {assigned && <label className={styles.field}>Project instructions<NeumorphicTextField variant="standard" multiline rows={3}
          aria-label="Project instructions" maxLength={20_000} placeholder="Additional instructions for this project"
          value={instructions} onChange={event => { setInstructions(event.target.value); setSaved(false); }} /></label>}
        {assigned && <InstructionFiles label="Project instruction files" paths={instructionFiles} model={model} disabled={disabled}
          onBusy={setFilePending} onChange={paths => { setInstructionFiles(paths); setSaved(false); }} />}
        <p className={styles.description}>Save settings, then use Advanced to manage the project worker.</p>
      </div>
    </fieldset>
    {outdated && <p className={styles.description} role="status">This agent changed in another window. Reopen its settings to load the latest version; your current draft is preserved.</p>}
    {state.error && <p role="alert" className={styles.description}>{state.error}</p>}
    {saved && !outdated && <p role="status" className={styles.description}>Agent saved.</p>}
    <div className={styles.actions}>
      <NeumorphicButton type="button" variant="ghost" disabled={disabled} onClick={() => { if (onBack) onBack(); else model.select(null); }}>Cancel</NeumorphicButton>
      <NeumorphicButton type="submit" disabled={disabled || modelBlocked || !profile.name.trim() || !profile.instructions.trim() || Boolean(outdated)}>
        {state.saving ? 'Saving…' : agent ? 'Save agent' : 'Create agent'}</NeumorphicButton>
    </div>
  </form>;
}
