import { useEffect, useRef, useState } from 'react';
import type { AgentRegistryState, AgentRegistryModel } from './agentRegistryModel';
import type { SpecialistAgent, SpecialistProfile } from '../../../../shared/agent-registry';
import { SPECIALIST_ROLES } from '../../../../shared/agent-registry';
import type { CodexAccountsApi, CodexAccountProfile } from '../../../../shared/codex-accounts';
import { LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { specialistTemplates } from './specialistTemplates';
import styles from './SpecialistAgentForm.module.css';

function initialProfile(agent?: SpecialistAgent): SpecialistProfile {
  return agent ? { name: agent.name, role: agent.role, instructions: agent.instructions,
    accountId: agent.accountId, model: agent.model, permissions: { ...agent.permissions } } : {
    name: '', role: 'development', instructions: specialistTemplates.development.instructions,
    accountId: null, model: null, permissions: { fileWrite: false, commandExecution: false },
  };
}

export function SpecialistAgentForm({ agent, model, state, accountsApi }: {
  agent?: SpecialistAgent; model: AgentRegistryModel; state: AgentRegistryState;
  accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const workspaceRoot = state.data!.workspaceRoot;
  const assignment = agent?.assignments.find(item => item.workspaceRoot === workspaceRoot);
  const [profile, setProfile] = useState(() => initialProfile(agent));
  const [revision, setRevision] = useState(agent?.revision ?? null);
  const [assigned, setAssigned] = useState(agent ? Boolean(assignment) : true);
  const [instructions, setInstructions] = useState(assignment?.instructions ?? '');
  const [accounts, setAccounts] = useState<CodexAccountProfile[]>([]);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const active = useRef(true);
  const scrollbar = useAutoHideScrollbars<HTMLFormElement>();
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
    value: account.id, label: `${account.label || account.email || account.id}${account.usage.authenticated ? '' : ' (sign-in required)'}`,
  }))];
  if (profile.accountId && !accounts.some(account => account.id === profile.accountId)) {
    accountOptions.push({ value: profile.accountId, label: `${profile.accountId} (unavailable)` });
  }
  const outdated = agent && revision !== agent.revision;
  return <form ref={scrollbar} className={styles.form} aria-label={agent ? 'Agent settings' : 'Create agent'} onSubmit={event => {
    event.preventDefault();
    void model.save({ id: agent?.id ?? null, revision, profile,
      assignment: { assigned, instructions } }).then(result => {
      if (active.current) { setRevision(result.revision); setSaved(true); }
    }, () => { /* The model exposes the error without discarding the draft. */ });
  }}>
    <div className={styles.heading}><h2>{agent ? agent.name : 'Create agent'}</h2>
      <span>{agent ? 'Registered' : 'Cheshi-wide agent'}</span></div>
    <fieldset disabled={state.saving} className={styles.fields}>
      <label className={styles.field}>Name<NeumorphicTextField variant="standard" aria-label="Agent name" required maxLength={100}
        value={profile.name} onChange={event => patch({ name: event.target.value })} /></label>
      <div className={styles.field}><span>Specialty</span><LiquidGlassSelect ariaLabel="Agent specialty" menuAppearance="toolbar" triggerAppearance="standard"
        value={profile.role} disabled={state.saving} options={SPECIALIST_ROLES.map(value => ({ value, label: specialistTemplates[value].label }))}
        onChange={role => patch({ role, instructions: profile.instructions === specialistTemplates[profile.role].instructions
          ? specialistTemplates[role].instructions : profile.instructions })} /></div>
      <label className={styles.field}>Instructions<NeumorphicTextField variant="standard" multiline rows={5} aria-label="Agent instructions"
        required maxLength={20_000} value={profile.instructions} onChange={event => patch({ instructions: event.target.value })} /></label>
      <div className={styles.field}><span>Account</span><LiquidGlassSelect ariaLabel="Agent account" menuAppearance="toolbar" triggerAppearance="standard"
        options={accountOptions} value={profile.accountId ?? ''} disabled={state.saving} onChange={accountId => patch({ accountId: accountId || null })} /></div>
      {accountError && <p role="status" className={styles.description}>{accountError}</p>}
      <label className={styles.field}>Model<NeumorphicTextField variant="standard" aria-label="Agent model" maxLength={200}
        placeholder="Runtime default" value={profile.model ?? ''} onChange={event => patch({ model: event.target.value || null })} /></label>
      <div className={styles.field}><h3>Execution permissions</h3>
        <p className={styles.description}>Saved policy for this agent's future execution environment.</p>
        <div className={styles.switchRow}><span>Modify project files</span><ToggleSwitch aria-label="Allow agent file changes" checked={profile.permissions.fileWrite}
          disabled={state.saving} onChange={fileWrite => patch({ permissions: { ...profile.permissions, fileWrite } })} /></div>
        <div className={styles.switchRow}><span>Run commands</span><ToggleSwitch aria-label="Allow agent commands" checked={profile.permissions.commandExecution}
          disabled={state.saving} onChange={commandExecution => patch({ permissions: { ...profile.permissions, commandExecution } })} /></div>
      </div>
      <div className={styles.field}><h3>Project assignment</h3>
        <p className={styles.description}>{workspaceRoot}</p>
        <div className={styles.switchRow}><span>Assign to this project</span><ToggleSwitch aria-label="Assign agent to this project" checked={assigned}
          disabled={state.saving} onChange={value => { setAssigned(value); setSaved(false); }} /></div>
        {assigned && <label className={styles.field}>Project instructions<NeumorphicTextField variant="standard" multiline rows={3}
          aria-label="Project instructions" maxLength={20_000} placeholder="Additional instructions for this project"
          value={instructions} onChange={event => { setInstructions(event.target.value); setSaved(false); }} /></label>}
        <p className={styles.description}>Execution is not configured yet. This step saves the agent and its project assignment.</p>
      </div>
    </fieldset>
    {outdated && <p className={styles.description} role="status">This agent changed in another window. Reopen its settings to load the latest version; your current draft is preserved.</p>}
    {state.error && <p role="alert" className={styles.description}>{state.error}</p>}
    {saved && !outdated && <p role="status" className={styles.description}>Agent saved.</p>}
    <div className={styles.actions}>
      <NeumorphicButton type="button" variant="ghost" disabled={state.saving} onClick={() => model.select(null)}>Cancel</NeumorphicButton>
      <NeumorphicButton type="submit" disabled={state.saving || !profile.name.trim() || !profile.instructions.trim() || Boolean(outdated)}>
        {state.saving ? 'Saving…' : agent ? 'Save agent' : 'Create agent'}</NeumorphicButton>
    </div>
  </form>;
}
