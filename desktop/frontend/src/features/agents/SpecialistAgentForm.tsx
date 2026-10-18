import { localSettingsKey, type HomieEditorDraft } from './homieEditorDraft';
import { HomieSourcePanel } from './HomieSourcePanel';
import { HomieCredentials } from './HomieCredentials';
import { HomieHostTool } from './HomieHostTool';
import { HomieHostToolPolicy } from './HomieHostToolPolicy';
import { HomieParticipation } from './HomieParticipation';
import { createHomiePack } from './homiePackAuthoring';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { defaultAgentAvatar, randomAgentAvatar } from '../../../../shared/agent-avatar';
import { AgentAvatarPicker } from './AgentAvatarPicker';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentRegistryState, AgentRegistryModel } from './agentRegistryModel';
import type { SpecialistAgent, SpecialistProfile } from '../../../../shared/agent-registry';
import { agentDisplayName, EXECUTION_PRESETS, SPECIALIST_ROLES } from '../../../../shared/agent-registry';
import type { CodexAccountsApi } from '../../../../shared/codex-accounts';
import { NeumorphicButton, NeumorphicTextField, LiquidGlassSelect } from '../../shared/ui';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { specialistTemplates } from './specialistTemplates';
import styles from './SpecialistAgentForm.module.css';
import layout from './HomieSettings.module.css';
import { applyAgentPackage, parseAgentPackage, type AgentPackage } from '../../../../shared/agent-package';
import { SpecialistModelSettings, useSpecialistModels, useHomieAccounts } from './SpecialistModelSettings';
import { assertAgentModelSelection, resolveAgentModelSelection, sameAgentModelSelection } from '../../../../shared/agent-models';

function initialProfile(agent?: SpecialistAgent): SpecialistProfile {
  return agent ? { ...agent } : { avatar: randomAgentAvatar(), name: '', role: 'development', instructions: specialistTemplates.development.instructions,
    accountId: null, model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false } };
}
export function SpecialistAgentForm({ inline = false, fill = false, active: visible = true, agent, model, state, accountsApi, onBack, runtime, roomId, engineId, draft, onDraft, onBusy, onDelete, initialPackage, onSaved, onReload, importing = false }: {
  inline?: boolean; fill?: boolean; active?: boolean;
  importing?: boolean; draft?: HomieEditorDraft; initialPackage?: AgentPackage | null;
  onSaved?(): void; onReload?(): void; onDraft?(draft: HomieEditorDraft): void; onBusy?(busy: boolean): void;
  onDelete?(): void;
  roomId?: string; engineId?: string | null; onBack?: () => void;
  runtime?: (headerTarget: HTMLElement | null, disabled: boolean) => ReactNode; runtimeRequested?: boolean;
  agent?: SpecialistAgent; model: AgentRegistryModel; state: AgentRegistryState;
  accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const workspaceRoot = state.data!.workspaceRoot, assignment = agent?.assignments.find(a => a.workspaceRoot === workspaceRoot);
  const [profile, setProfile] = useState(() => draft?.profile ?? (initialPackage ? applyAgentPackage(initialProfile(), initialPackage, false, false) : initialProfile(agent)));
  const [permissions, setPermissions] = useState(draft?.permissions ?? assignment?.permissions ?? initialPackage?.requestedPermissions ?? agent?.permissions ?? EXECUTION_PRESETS.development);
  const [assigned, setAssigned] = useState(draft?.assigned ?? (agent ? Boolean(assignment) : true));
  const [revision, setRevision] = useState(draft?.revision ?? agent?.revision ?? null);
  const [pack, setPack] = useState(() => draft?.localPack ?? profile.package ?? createHomiePack(profile, permissions));
  const [filePending, setFilePending] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false);
  const [hostPending, setHostPending] = useState(false);
  const [hostPolicyRevision, setHostPolicyRevision] = useState(0);
  const { profiles: accounts, loading: accountsLoading, error: accountError } = useHomieAccounts(model.catalog, accountsApi);
  const [runtimeHeader, setRuntimeHeader] = useState<HTMLElement | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const active = useRef(false), operation = useRef(false);
  const scroll = useAutoHideScrollbars<HTMLDivElement>();
  const disabled = state.saving || filePending || hostPending || importing;
  const currentLocalKey = localSettingsKey({ profile, permissions, assigned });
  const savedLocalKey = agent ? localSettingsKey({ profile: agent, permissions: assignment?.permissions ?? agent.permissions,
    assigned: Boolean(assignment) }) : null;
  const [localSettingsBaseline, setLocalSettingsBaseline] = useState(() => draft?.localSettingsBaseline ?? savedLocalKey);
  const locallyEdited = currentLocalKey !== localSettingsBaseline;
  const catalog = useSpecialistModels(profile.accountId, model.catalog);
  let modelError: string | null = null;
  try { assertAgentModelSelection(profile, catalog.models); }
  catch (error) { modelError = error instanceof Error ? error.message : 'Invalid model selection.'; }
  const selection = resolveAgentModelSelection(profile, catalog.models);
  const modelBlocked = (Boolean(profile.accountId) || profile.model !== null) && (catalog.loading || !catalog.models.length || selection.model === null || Boolean(modelError));
  useEffect(() => {
    if (!profile.accountId || disabled || !catalog.models.length) return;
    setProfile(current => sameAgentModelSelection(current, selection) ? current : { ...current, ...selection });
  }, [profile.accountId, disabled, catalog.models, selection.model, selection.reasoningEffort, selection.serviceTier]);
  const outdated = agent && revision !== agent.revision;
  useEffect(() => {
    if (!agent || !outdated || locallyEdited || disabled) return;
    setProfile({ ...agent }); setPermissions(assignment?.permissions ?? agent.permissions);
    setAssigned(Boolean(assignment));
    setPack(agent.package ?? createHomiePack(agent, assignment?.permissions ?? agent.permissions));
    setRevision(agent.revision); setLocalSettingsBaseline(savedLocalKey); setSaved(false);
  }, [agent, assignment, outdated, locallyEdited, disabled, savedLocalKey]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { onBusy?.(disabled); return () => { onBusy?.(false); }; }, [disabled, onBusy]);
  useEffect(() => { onDraft?.({ profile, permissions, revision, assigned, localPack: pack, section: 'basic',
    ...(localSettingsBaseline === null ? {} : { localSettingsBaseline }) }); },
    [profile, permissions, revision, assigned, pack, localSettingsBaseline, onDraft]);
  const patch = (value: Partial<SpecialistProfile>) => { setProfile(p => ({ ...p, ...value })); setSaved(false); };
  const accountOptions = [{ value: '', label: 'Configure later' }, ...accounts.map(a => ({ value: a.id, label: `${a.label || a.id}${a.usage.authenticated ? '' : ' (sign-in required)'}` }))];
  if (profile.accountId && !accounts.some(a => a.id === profile.accountId)) accountOptions.push({ value: profile.accountId, label: accountsLoading ? 'Loading account…' : 'Unavailable account' });
  const saveButton = <NeumorphicButton type="submit" variant="standard" disabled={disabled || modelBlocked || Boolean(outdated) || !agentDisplayName(profile).trim()}>
    {state.starting ? 'Preparing environment…' : state.saving ? 'Saving…' : agent ? 'Save local settings' : 'Create agent'}
  </NeumorphicButton>;
  return <form className={layout.editor} data-inline={inline || undefined} data-fill={fill || undefined} noValidate aria-label={agent ? 'Agent settings' : 'Create agent'} onSubmit={event => {
    event.preventDefault();
    if (disabled || modelBlocked || operation.current || outdated || !agentDisplayName(profile).trim()) return;
    let definition: AgentPackage;
    try { definition = parseAgentPackage({ ...pack, name: profile.name, role: profile.role, instructions: profile.instructions || 'Follow the assigned task and project instructions.',
      model: selection, requestedPermissions: initialPackage ? pack.requestedPermissions : permissions }); }
    catch (error) { setError(error instanceof Error ? error.message : 'Invalid Homie configuration.'); return; }
    operation.current = true; setError(null);
    void model.save({ id: agent?.id ?? null, revision, profile: { ...profile, ...selection, instructions: definition.instructions, package: agent?.package ?? definition },
      assignment: { assigned, instructions: '', permissions } }, engineId).then(result => {
        onSaved?.(); if (active.current) { setRevision(result.revision); setLocalSettingsBaseline(currentLocalKey); setSaved(true); }
      }, () => {}).finally(() => { operation.current = false; });
  }}>
    {(!inline || agent) && <header className={layout.header}>
      {onBack && <TooltipButton variant="ghost" size="icon" aria-label="All Homies" title="All Homies" disabled={disabled} onClick={onBack}><ArrowLeft aria-hidden="true" /></TooltipButton>}
      <h2 className={layout.title}>{agent ? agentDisplayName(agent) : (profile.name || 'Create agent')}</h2>
      {!agent && saveButton}
      {onDelete && <TooltipButton variant="ghost" size="icon" title="Delete Homie" aria-label={`Delete agent: ${agent ? agentDisplayName(agent) : ''}`} disabled={disabled} onClick={onDelete}><Trash2 aria-hidden="true" /></TooltipButton>}
    </header>}
    <div ref={scroll} className={layout.scroll}>
      <div className={layout.section}>
        {agent ? <HomieSourcePanel active={visible} actionsTarget={actionsTarget} agentId={agent.id} engineId={engineId} model={model} disabled={disabled} onBusy={setFilePending} /> : <section className={layout.section}>
          <label className={styles.field}>Specialty<LiquidGlassSelect ariaLabel="Agent specialty" menuAppearance="toolbar" triggerAppearance="standard" value={profile.role} disabled={disabled}
            options={SPECIALIST_ROLES.map(value => ({ value, label: specialistTemplates[value].label }))} onChange={value => {
              const role = value as SpecialistProfile['role']; patch({ role, instructions: specialistTemplates[role].instructions });
              setPermissions(role === 'development' || role === 'frontend' ? EXECUTION_PRESETS.development : role === 'verification' ? EXECUTION_PRESETS.verification : EXECUTION_PRESETS.review);
            }} /></label>
          <label className={styles.field}>Description<NeumorphicTextField variant="standard" multiline rows={2} aria-label="Homie description" value={pack.description} disabled={disabled} onChange={e => setPack(p => ({ ...p, description: e.target.value }))} /></label>
          <p className={styles.description}>Create a private repository and prepare the worker. Manage instructions, skills, tools and environment in its files afterward.</p>
        </section>}
        <section className={layout.section}>
          <div className={styles.identityRow}>
            <AgentAvatarPicker value={profile.avatar ?? defaultAgentAvatar(agent?.id ?? 'new')} disabled={disabled} onChange={avatar => patch({ avatar })} />
            <NeumorphicTextField variant="standard" aria-label={agent ? 'Homie display name' : 'Agent name'} placeholder="Name"
              maxLength={100} value={agentDisplayName(profile)} disabled={disabled}
              onChange={event => patch(agent ? { displayName: event.target.value } : { name: event.target.value })} />
          </div>
          <label className={`${styles.field} ${styles.accountRow}`}><span>Account</span><LiquidGlassSelect ariaLabel="Agent account" menuAppearance="toolbar" triggerAppearance="standard" value={profile.accountId ?? ''} options={accountOptions} disabled={disabled} onChange={accountId => patch(accountId ? { accountId } : { accountId: null, model: null, reasoningEffort: null, serviceTier: null })} /></label>
          {accountError && <p role="alert" className={styles.description}>{accountError}</p>}
          <SpecialistModelSettings selection={selection} catalog={catalog} disabled={disabled} onChange={patch} />
          {modelError && !catalog.loading && profile.model !== null && <p role="alert" className={styles.description}>{modelError}</p>}
          <div className={styles.switchRow}><span>Assign to this project</span><ToggleSwitch aria-label="Assign agent to this project" checked={assigned} disabled={disabled} onChange={setAssigned} /></div>
          <div className={styles.switchRow}><span>Modify project files</span><ToggleSwitch aria-label="Allow agent file changes" checked={permissions.fileWrite} disabled={disabled} onChange={fileWrite => setPermissions(p => ({ ...p, fileWrite }))} /></div>
          <div className={styles.switchRow}><span>Run commands</span><ToggleSwitch aria-label="Allow agent commands" checked={permissions.commandExecution} disabled={disabled} onChange={commandExecution => setPermissions(p => ({ ...p, commandExecution }))} /></div>
        </section>
        <HomieCredentials pack={agent?.package} model={model} disabled={disabled} />
        {agent?.package?.tools?.some(tool => tool.execution === 'host') && <section className={layout.section} aria-label="Local host tools">
          <h3>Local host tools</h3>
          <HomieHostToolPolicy key={`${agent.id}:${workspaceRoot}:${agent.accountId}`} model={model} agentId={agent.id}
            tool={agent.package.tools.find(tool => tool.execution === 'host')!.name}
            saved={assigned && !locallyEdited && !outdated} disabled={disabled} onBusy={setHostPending}
            onChanged={() => setHostPolicyRevision(value => value + 1)} />
          {agent.package.tools.filter(tool => tool.execution === 'host').map(tool => <div className={layout.section} key={tool.name}>
            <span className={styles.description}>{tool.name}</span>
            <HomieHostTool model={model} agentId={agent.id} tool={tool.name} runtime={tool.runtime} reviewKey={`${agent.revision}:${hostPolicyRevision}`}
              saved={assigned && !locallyEdited && !outdated} disabled={disabled} onBusy={setHostPending} />
          </div>)}
        </section>}
        {!agent && inline && <div className={layout.joinAction}>{saveButton}</div>}
        {agent && <div className={layout.actionSection}>
          <HomieParticipation agent={agent} workspaceRoot={workspaceRoot} roomId={roomId} />
          <div ref={setActionsTarget} className={layout.saveActions} role="group" aria-label="Homie actions">
            {saveButton}
          </div>
        </div>}
        {runtime && <fieldset ref={setRuntimeHeader} disabled={disabled} className={layout.runtimeHeader} aria-label="Homie runtime controls" />}
        {outdated && locallyEdited && <p className={styles.description} role="status">Settings changed. Your local draft is preserved. {onReload && <NeumorphicButton variant="ghost" disabled={disabled} onClick={onReload}>Reload saved settings</NeumorphicButton>}</p>}
        {error && <p role="alert">{error}</p>}{state.error && <p role="alert">{state.error}</p>}
        {saved && !outdated && <p role="status" className={styles.description}>Local settings saved.</p>}
        {state.starting && <p role="status" className={styles.description}>Homie saved. Preparing its environment and starting the worker…</p>}
        {runtime && <fieldset disabled={disabled} className={layout.runtime} aria-label="Docker runtime">{runtime(runtimeHeader, disabled)}</fieldset>}
      </div>
    </div>
  </form>;
}
