import type { HomieEditorDraft } from './homieEditorDraft';
import { ToolbarMenu } from '../../shared/ui/ToolbarMenu';
import { HomieCustomTools } from './HomieCustomTools';
import { HomieParticipation } from './HomieParticipation';
import { HomieTools, HomiePrograms } from './HomieConfigurationSections';
import { PackFiles, PackSkills } from './HomiePackAssets';
import { createHomiePack } from './homiePackAuthoring';
import layout from './HomieSettings.module.css';
import { ArrowLeft, Copy, Download, FileText, Folder, Info, Plug, Sparkles, Trash2, Wrench } from 'lucide-react';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { defaultAgentAvatar, randomAgentAvatar } from '../../../../shared/agent-avatar';
import { AgentAvatarPicker } from './AgentAvatarPicker';
import { InstructionFiles } from './InstructionFiles';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentRegistryState, AgentRegistryModel } from './agentRegistryModel';
import type { SpecialistAgent, SpecialistProfile } from '../../../../shared/agent-registry';
import { EXECUTION_PRESETS, SPECIALIST_ROLES } from '../../../../shared/agent-registry';
import type { CodexAccountsApi, CodexAccountProfile } from '../../../../shared/codex-accounts';
import { LiquidGlassPanel, LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { ToggleSwitch } from '../../shared/ui/ToggleSwitch';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { specialistTemplates } from './specialistTemplates';
import styles from './SpecialistAgentForm.module.css';
import { SpecialistModelSettings, useSpecialistModels } from './SpecialistModelSettings';
import { assertAgentModelSelection } from '../../../../shared/agent-models';
import { applyAgentPackage, parseAgentPackage, type AgentPackage } from '../../../../shared/agent-package';
import { AgentPackagePicker } from './AgentPackagePicker';

function initialProfile(agent?: SpecialistAgent): SpecialistProfile {
  return agent ? { avatar: agent.avatar ?? defaultAgentAvatar(agent.id), name: agent.name, role: agent.role, instructions: agent.instructions,
    instructionFiles: agent.instructionFiles ?? [], accountId: agent.accountId, model: agent.model, reasoningEffort: agent.reasoningEffort, serviceTier: agent.serviceTier,
    permissions: { ...agent.permissions }, package: agent.package } : {
    avatar: randomAgentAvatar(), name: '', role: 'development', instructions: specialistTemplates.development.instructions,
    accountId: null, model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false },
  };
}

export function SpecialistAgentForm({ agent, model, state, accountsApi, onBack, runtime, runtimeRequested, roomId, engineId, draft, onDraft, onBusy, onDelete, onDuplicate, initialPackage, onSaved, onReload, importing = false }: {
  importing?: boolean;
  draft?: HomieEditorDraft; initialPackage?: AgentPackage | null;
  onSaved?(): void; onReload?(): void;
  onDraft?(draft: HomieEditorDraft): void; onBusy?(busy: boolean): void;
  onDelete?(): void; onDuplicate?(draft: HomieEditorDraft): void;
  roomId?: string; engineId?: string | null;
  onBack?: () => void; runtime?: (onSettings: () => void, headerTarget: HTMLElement | null) => ReactNode; runtimeRequested?: boolean;
  agent?: SpecialistAgent; model: AgentRegistryModel; state: AgentRegistryState;
  accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const workspaceRoot = state.data!.workspaceRoot;
  const assignment = agent?.assignments.find(item => item.workspaceRoot === workspaceRoot);
  const [profile, setProfile] = useState(() => draft?.profile ?? (initialPackage ? applyAgentPackage(initialProfile(), initialPackage, false, false) : initialProfile(agent)));
  const [permissions, setPermissions] = useState(draft?.permissions ?? initialPackage?.requestedPermissions ?? assignment?.permissions ?? agent?.permissions ?? EXECUTION_PRESETS.development);
  const [revision, setRevision] = useState(draft?.revision ?? agent?.revision ?? null);
  const [assigned, setAssigned] = useState(draft?.assigned ?? (agent ? Boolean(assignment) : true));
  const [instructions, setInstructions] = useState(draft?.instructions ?? assignment?.instructions ?? '');
  const [instructionFiles, setInstructionFiles] = useState(draft?.instructionFiles ?? assignment?.instructionFiles ?? []);
  const [filePending, setFilePending] = useState(false);
  const [section, setSection] = useState(draft?.section ?? 'basic');
  const [localPack, setLocalPack] = useState(() => draft?.localPack ?? createHomiePack(initialProfile(agent), permissions));
  const pack = profile.package ?? localPack;
  const operation = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (runtimeRequested) setSection('environment'); }, [runtimeRequested]);
  const disabled = state.saving || filePending || importing;
  const [runtimeHeader, setRuntimeHeader] = useState<HTMLElement | null>(null);
  useEffect(() => { onBusy?.(disabled); return () => onBusy?.(false); }, [disabled, onBusy]);
  useEffect(() => { onDraft?.({ profile, permissions, revision, assigned, instructions, instructionFiles, localPack, section }); },
    [profile, permissions, revision, assigned, instructions, instructionFiles, localPack, section, onDraft]);
  const [accounts, setAccounts] = useState<CodexAccountProfile[]>([]);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const active = useRef(true);
  const scrollbar = useAutoHideScrollbars<HTMLDivElement>();
  const navigation = useAutoHideScrollbars<HTMLElement>();
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
  const patch = (value: Partial<SpecialistProfile>) => { setProfile(current => ({ ...current, ...value })); setSaved(false); setNotice(null); };
  const accountOptions = [{ value: '', label: 'Configure later' }, ...accounts.map(account => ({
    value: account.id, label: `${account.email || account.label || account.id}${account.usage.authenticated ? '' : ' (sign-in required)'}`,
  }))];
  if (profile.accountId && !accounts.some(account => account.id === profile.accountId)) {
    accountOptions.push({ value: profile.accountId, label: `${profile.accountId} (unavailable)` });
  }
  const outdated = agent && revision !== agent.revision;
  const patchPack = (values: Partial<AgentPackage>) => {
    if (profile.package) patch({ package: { ...profile.package, ...values } });
    else { setLocalPack(current => ({ ...current, ...values })); setSaved(false); setNotice(null); }
  };
  const portable = () => parseAgentPackage({ ...pack, name: profile.name, role: profile.role, instructions: profile.instructions,
    model: { model: profile.model, reasoningEffort: profile.reasoningEffort, serviceTier: profile.serviceTier }, requestedPermissions: permissions });
  const exportPack = async () => {
    if (disabled || operation.current) return;
    operation.current = true; setFilePending(true); setPackError(null); setNotice(null);
    try {
      const exported = await model.exportPackage(portable(), profile.instructionFiles);
      if (active.current && exported) setNotice('Homie pack exported.');
    } catch (error) { if (active.current) setPackError(error instanceof Error ? error.message : 'Could not export Homie pack.'); }
    finally { operation.current = false; if (active.current) setFilePending(false); }
  };
  const files = pack.resources?.files ?? [];
  const assets = { files, disabled, onBusy: setFilePending, onError: setPackError,
    onChange: (files: NonNullable<AgentPackage['resources']>['files']) => patchPack({ resources: { files, programs: pack.resources?.programs ?? [] } }) };
  const sections = [
    { id: 'basic', label: 'Basic information', icon: Info }, { id: 'instructions', label: 'Instructions', icon: FileText },
    { id: 'skills', label: 'Skills', icon: Sparkles }, { id: 'tools', label: 'Tools', icon: Wrench },
    { id: 'plugins', label: 'Plugins', icon: Plug },
    { id: 'environment', label: 'Files and environment', icon: Folder },
  ];
  return <form className={layout.editor} noValidate aria-label={agent ? 'Agent settings' : 'Create agent'} onSubmit={event => {
    event.preventDefault();
    if (modelBlocked || disabled || operation.current || outdated || !profile.name.trim() || !profile.instructions.trim()) return;
    let savedProfile = profile;
    try { savedProfile = { ...profile, package: profile.package ? parseAgentPackage(profile.package) : portable() }; setPackError(null); }
    catch (error) { setPackError(error instanceof Error ? error.message : 'Invalid Homie pack.'); return; }
    operation.current = true;
    void model.save({ id: agent?.id ?? null, revision, profile: savedProfile,
      assignment: { assigned, instructions, instructionFiles, permissions } }).then(result => {
      onSaved?.();
      if (active.current) { setRevision(result.revision); setSaved(true); setNotice(null); }
    }, () => { /* The model exposes the error without discarding the draft. */ }).finally(() => { operation.current = false; });
  }}>
    <header className={layout.header}>
      {onBack && <TooltipButton variant="ghost" size="icon" aria-label="All Homies" title="All Homies" disabled={disabled} onClick={onBack}><ArrowLeft aria-hidden="true" /></TooltipButton>}
      <h2 className={layout.title}>{outdated ? agent.name : profile.name || 'Create agent'}</h2>
      <NeumorphicButton type="submit" variant="standard" disabled={disabled || modelBlocked || !profile.name.trim() || !profile.instructions.trim() || Boolean(outdated)}>
        {state.saving ? 'Saving…' : agent ? 'Save agent' : 'Create agent'}</NeumorphicButton>
      <ToolbarMenu label="Homie actions" items={[
        { id: 'export', label: 'Export…', icon: <Download aria-hidden="true" />, disabled: disabled || modelBlocked || !profile.name.trim() || !profile.instructions.trim(), onSelect: () => { void exportPack(); } },
        ...(onDuplicate ? [{ id: 'duplicate', label: 'Duplicate Homie', icon: <Copy aria-hidden="true" />, disabled: disabled || !profile.name.trim(),
          onSelect: () => onDuplicate({ profile, permissions, revision, assigned, instructions, instructionFiles, localPack, section }) }] : []),
        ...(onDelete ? [{ id: 'delete', label: `Delete agent: ${agent?.name}`, icon: <Trash2 aria-hidden="true" />, disabled,
          separatorBefore: true, onSelect: onDelete }] : []),
      ]} />
      {runtime && <fieldset ref={setRuntimeHeader} disabled={disabled} className={layout.runtimeHeader} aria-label="Homie runtime controls" />}
    </header>
    <div className={layout.body}>
      <LiquidGlassPanel as="aside" className={layout.navigation}>
        <nav ref={navigation} className={layout.navScroll} aria-label="Homie sections">
          {sections.map(({ id, label, icon: Icon }) => <NeumorphicButton key={id} variant="ghost" className={layout.navItem}
            aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}><Icon aria-hidden="true" />{label}</NeumorphicButton>)}
        </nav>
      </LiquidGlassPanel>
      <div ref={scrollbar} className={layout.scroll}>
        <fieldset disabled={disabled} className={styles.fields}>
          <section hidden={section !== 'basic'} className={layout.section} aria-label="Basic information settings">
            <h3>Basic information</h3>
            <AgentAvatarPicker value={profile.avatar!} disabled={disabled} onChange={avatar => patch({ avatar })} />
            <label className={styles.field}>Name<NeumorphicTextField variant="standard" aria-label="Agent name" required maxLength={100}
              value={profile.name} onChange={event => patch({ name: event.target.value })} /></label>
            <div className={styles.field}><span>Specialty</span><LiquidGlassSelect ariaLabel="Agent specialty" menuAppearance="toolbar" triggerAppearance="standard"
              value={profile.role} disabled={disabled} options={SPECIALIST_ROLES.map(value => ({ value, label: specialistTemplates[value].label }))}
              onChange={role => {
                patch({ role, instructions: profile.instructions === specialistTemplates[profile.role].instructions ? specialistTemplates[role].instructions : profile.instructions });
                if (!agent) setPermissions({ ...EXECUTION_PRESETS[role === 'verification' ? 'verification' : role === 'development' || role === 'frontend' ? 'development' : 'review'] });
              }} /></div>
            <label className={styles.field}>Description<NeumorphicTextField variant="standard" multiline rows={3} aria-label="Homie description" maxLength={2000}
              value={pack.description} onChange={event => patchPack({ description: event.target.value })} /></label>
            <details><summary>Homie pack</summary><div className={layout.advanced}>
            <AgentPackagePicker profile={profile} model={model} existing={Boolean(agent)} disabled={disabled} onBusy={setFilePending}
              onApply={(definition, keepInstructions) => {
                patch(applyAgentPackage(profile, definition, Boolean(agent), keepInstructions));
                if (!agent) setPermissions({ ...definition.requestedPermissions });
              }} />
              <label className={styles.field}>Version<NeumorphicTextField variant="standard" aria-label="Homie pack version" value={pack.version} onChange={event => patchPack({ version: event.target.value })} /></label>
              <p className={styles.description}>Export includes instructions, skills, tools and environment. Accounts, conversations and project settings stay on this computer.</p>
            </div></details>
            <div className={styles.field}><span>Account</span><LiquidGlassSelect ariaLabel="Agent account" menuAppearance="toolbar" triggerAppearance="standard"
              options={accountOptions} value={profile.accountId ?? ''} disabled={disabled}
              onChange={accountId => patch({ accountId: accountId || null,
                ...(!agent && profile.package ? profile.package.model : { model: null, reasoningEffort: null, serviceTier: null }) })} /></div>
            {accountError && <p role="status" className={styles.description}>{accountError}</p>}
            <SpecialistModelSettings selection={profile} catalog={catalog} disabled={disabled} onChange={patch} />
            {modelError && !catalog.loading && !catalog.error && <p className={styles.description} role="alert">{modelError}</p>}
          </section>
          <section hidden={section !== 'instructions'} className={layout.section} aria-label="Instruction settings">
            <h3>Instructions</h3>
            <label className={styles.field}>Instructions<NeumorphicTextField variant="standard" multiline rows={5} aria-label="Agent instructions"
              required maxLength={20_000} value={profile.instructions} onChange={event => patch({ instructions: event.target.value })} /></label>
            <InstructionFiles label="Common instruction files" paths={profile.instructionFiles ?? []} model={model} disabled={disabled}
              onBusy={setFilePending} onChange={instructionFiles => patch({ instructionFiles })} />
              {assigned && <label className={styles.field}>Project instructions<NeumorphicTextField variant="standard" multiline rows={3}
                aria-label="Project instructions" maxLength={20_000} placeholder="Additional instructions for this project"
                value={instructions} onChange={event => { setInstructions(event.target.value); setSaved(false); }} /></label>}
              {assigned && <InstructionFiles label="Project instruction files" paths={instructionFiles} model={model} disabled={disabled}
                onBusy={setFilePending} onChange={paths => { setInstructionFiles(paths); setSaved(false); }} />}
          </section>
          <section hidden={section !== 'skills'} className={layout.section}><PackSkills {...assets} /></section>
          <section hidden={section !== 'tools'} className={layout.section}>
            <h3>Tools</h3><HomieTools pack={pack} disabled={disabled} patch={patchPack} />
            <HomieCustomTools pack={pack} savedPack={agent?.package} patch={patchPack} disabled={disabled} model={model} agentId={agent?.id} engineId={engineId} onBusy={setFilePending} />
            <div className={styles.field}><h3>Execution permissions</h3>
              <p className={styles.description}>Applies to this project. Choose permissions before starting the worker. Changing them later replaces its idle container and preserves conversations. Command access prepares Linux dependencies before work.</p>
              <LiquidGlassSelect ariaLabel="Execution permission preset" menuAppearance="toolbar" triggerAppearance="standard"
                value={Object.entries(EXECUTION_PRESETS).find(([, p]) => p.fileWrite === permissions.fileWrite && p.commandExecution === permissions.commandExecution)?.[0] ?? 'custom'}
                disabled={disabled} options={[{ value: 'development', label: 'Development · Files and commands' }, { value: 'verification', label: 'Verification · Commands only' }, { value: 'review', label: 'Review · Read only' }, { value: 'custom', label: 'Custom' }]}
                onChange={value => { if (value in EXECUTION_PRESETS) { setPermissions({ ...EXECUTION_PRESETS[value as keyof typeof EXECUTION_PRESETS] }); setSaved(false); } }} />
              <div className={styles.switchRow}><span>Modify project files</span><ToggleSwitch aria-label="Allow agent file changes" checked={permissions.fileWrite}
                disabled={disabled} onChange={fileWrite => { setPermissions({ ...permissions, fileWrite }); setSaved(false); }} /></div>
              <div className={styles.switchRow}><span>Run commands</span><ToggleSwitch aria-label="Allow agent commands" checked={permissions.commandExecution}
                disabled={disabled} onChange={commandExecution => { setPermissions({ ...permissions, commandExecution }); setSaved(false); }} /></div>
            </div>
          </section>
          <section hidden={section !== 'plugins'} className={layout.section} aria-label="Plugin settings">
            <h3>Codex plugins</h3>
            <p className={styles.description}>Connect this Homie to the skills and tools provided by Codex plugins.</p>
            <NeumorphicButton variant="standard" disabled><Plug aria-hidden="true" />Add plugin</NeumorphicButton>
            <p role="status" className={styles.description}>Docker plugin installation is not connected yet. Plugins installed on this computer are not automatically available to this Homie.</p>
          </section>
          <section hidden={section !== 'environment'} className={layout.section} aria-label="Files and environment settings">
            <div className={styles.field}><h3>Project assignment</h3>
              <p className={styles.description}>{workspaceRoot}</p>
              <div className={styles.switchRow}><span>Assign to this project</span><ToggleSwitch aria-label="Assign agent to this project" checked={assigned}
                disabled={disabled} onChange={value => { setAssigned(value); setSaved(false); }} /></div>
              <p className={styles.description}>Save settings before starting the worker. Docker uses the saved configuration; saving does not start or restart it.</p>
            </div>
            {agent && <HomieParticipation key={agent.id} agent={agent} workspaceRoot={workspaceRoot} roomId={roomId} />}

            <HomiePrograms pack={pack} disabled={disabled} patch={patchPack} report={setPackError} />
            <PackFiles {...assets} />
          </section>
        </fieldset>
        {runtime && <fieldset hidden={section !== 'environment'} disabled={disabled} className={`${styles.fields} ${layout.runtime}`} aria-label="Docker runtime">{runtime(() => setSection('basic'), runtimeHeader)}</fieldset>}
        {section === 'environment' && !agent && <p className={styles.description}>Create this Homie to manage its Docker worker.</p>}
      </div>
    </div>
    {outdated && <p className={styles.description} role="status">This agent changed in another window. Your current draft is preserved. {onReload && <NeumorphicButton variant="ghost" disabled={disabled} onClick={onReload}>Reload saved settings</NeumorphicButton>}</p>}
    {packError && <p role="alert" className={styles.description}>{packError}</p>}
    {state.error && <p role="alert" className={styles.description}>{state.error}</p>}
    {saved && !outdated && <p role="status" className={styles.description}>Agent saved.</p>}
    {notice && <p className={layout.status} role="status">{notice}</p>}
  </form>;
}
