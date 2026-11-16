import { agentDisplayName } from '../../../../shared/agent-registry';
import { useHomieParticipants } from './useHomieParticipants';
import type { HomieEditorDraft } from './homieEditorDraft';
import type { AgentChatsApi, ChatTaskTarget } from '../../../../shared/agent-chats';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { SpecialistRuntimePanel } from './SpecialistRuntimePanel';
import { Bot, Container, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassPanel, LiquidGlassSelect, NeumorphicButton, NeumorphicCheckbox } from '../../shared/ui';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { ToolbarMenu } from '../../shared/ui/ToolbarMenu';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { AgentManagementFrame, AgentManagementNotice } from '../../shared/agent-management/AgentManagementFrame';
import type { AgentScreenProps } from '../../shared/agent-management/AgentManagementFrame';
import viewStyles from './AgentsView.module.css';
import { SpecialistAgentForm } from './SpecialistAgentForm';
import type { AgentRegistryModel, AgentRegistryState } from './agentRegistryModel';
import type { CodexAccountsApi } from '../../../../shared/codex-accounts';
import { WorkerDeleteDialog } from '../../shared/agent-management/WorkerDeleteDialog';
import { HomieStatusBadge, HomieStatusIcon, homieSnapshotStatus, type HomieStatusLabel } from './HomieStatusIcon';
import type { SpecialistAgent } from '../../../../shared/agent-registry';

const emptyRegistry: AgentRegistryState = { data: null, selection: null, loading: false, saving: false, error: null };
const emptySnapshot = () => emptyRegistry;
const emptySubscribe = () => () => {};
const containerStateLabels: Record<string, string> = {
  running: 'Running', exited: 'Stopped', created: 'Not started', paused: 'Paused',
  restarting: 'Restarting', removing: 'Removing', dead: 'Error',
};

export function AgentsView({ active = true, chatTask, onBackToChats, selectionRequest, onClose, listTarget, onSelectionChange, onBusyChange, onEditingChange, onStopWorker, model, state, registry, accountsApi, chatsApi }: AgentScreenProps & {
  active?: boolean; chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  selectionRequest?: { agentId: string | null; roomId?: string }; onClose?(): void;
  listTarget?: HTMLElement | null; onSelectionChange?(id: string | null): void; onBusyChange?(busy: boolean): void; onEditingChange?(editing: boolean): void;
  onStopWorker?(engineId: string, workerId: string): Promise<void>;
  chatsApi?: AgentChatsApi;
  registry?: AgentRegistryModel | null; accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<{ agentId: string; label: HomieStatusLabel } | null>(null);
  const [runtimeActionsTarget, setRuntimeActionsTarget] = useState<HTMLElement | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [newDraftVersion, setNewDraftVersion] = useState(0);
  const drafts = useRef(new Map<string, HomieEditorDraft>());
  const openedSelection = useRef<typeof selectionRequest>(undefined);
  const [deletion, setDeletion] = useState<SpecialistAgent | null>(null);
  const registered = useSyncExternalStore(registry?.subscribe ?? emptySubscribe, registry?.snapshot ?? emptySnapshot);
  const participation = useHomieParticipants(selectionRequest?.roomId, registered.data?.agents ?? [], registered.data?.workspaceRoot, chatsApi);
  const openedChatTask = useRef<ChatTaskTarget | null>(null);
  useEffect(() => {
    if (chatTask && openedChatTask.current !== chatTask && registered.data?.agents.some(a => a.id === chatTask.agentId)) {
      openedChatTask.current = chatTask; registry?.select(chatTask.agentId); setAdvanced(true);
    }
  }, [chatTask, registry, registered.data]);
  useEffect(() => {
    if (registry && !registered.saving && selectionRequest && openedSelection.current !== selectionRequest) {
      openedSelection.current = selectionRequest; registry.select(selectionRequest.agentId); setAdvanced(false);
    }
  }, [registry, selectionRequest, registered.saving]);
  const railMode = listTarget !== undefined;
  const creating = registered.selection === 'new';
  useEffect(() => { onSelectionChange?.(registered.selection); }, [registered.selection, onSelectionChange]);
  const profile = creating ? undefined : registered.data?.agents.find(item => item.id === registered.selection);
  const editing = creating || Boolean(profile);
  const fullEditor = (!railMode && creating) || Boolean(profile && advanced && chatTask?.agentId === profile.id);
  const compactHeader = railMode && !fullEditor && (creating || Boolean(profile));
  useEffect(() => { onEditingChange?.(fullEditor); }, [fullEditor, onEditingChange]);
  const currentSelection = useRef(registered.selection);
  currentSelection.current = registered.selection;
  const reportEditorBusy = useCallback((busy: boolean) => {
    if (currentSelection.current === registered.selection) setEditorBusy(busy);
  }, [registered.selection]);
  const reportRuntimeStatus = useCallback((label: HomieStatusLabel | null) => {
    if (registered.selection && currentSelection.current === registered.selection) {
      setRuntimeStatus(label === null ? null : { agentId: registered.selection, label });
    }
  }, [registered.selection]);
  const listScrollbar = useAutoHideScrollbars<HTMLElement>();
  const menuBlurSourceRef = useRef<HTMLElement | null>(null);
  const connectParticipationBackdrop = useCallback((element: HTMLElement | null) => {
    // Include sidebar and status-bar borders behind the portalled menu.
    menuBlurSourceRef.current = element?.closest<HTMLElement>('.app-shell') ?? null;
  }, []);
  const { snapshot, changing, loading } = state;
  const locked = registered.saving || editorBusy || participation.saving;
  useEffect(() => { onBusyChange?.(locked); }, [locked, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);
  const editor = editing && <section className={viewStyles.detailsPane} aria-label="Agent details">
      {registry && registered.data && <div className={viewStyles.settingsPane}>
        <SpecialistAgentForm inline={!fullEditor} fill={railMode} active={active} engineId={state.engineId} key={`${profile?.id ?? 'new'}-${newDraftVersion}`} agent={profile} model={registry} state={registered}
          draft={drafts.current.get(profile?.id ?? 'new')}
          onSaved={creating ? () => { drafts.current.delete('new'); } : undefined}
          onReload={() => { drafts.current.delete(profile?.id ?? 'new'); setNewDraftVersion(value => value + 1); }}
          onDraft={draft => drafts.current.set(profile?.id ?? 'new', draft)} onBusy={reportEditorBusy}
          onDelete={fullEditor && profile ? () => setDeletion(profile) : undefined}
          accountsApi={accountsApi} roomId={selectionRequest?.roomId} onBack={fullEditor ? () => registry.select(null) : undefined} runtimeRequested={advanced}
          runtime={profile && active ? (headerTarget, disabled) => <SpecialistRuntimePanel onStatusChange={!fullEditor ? reportRuntimeStatus : undefined} headerTarget={headerTarget} compact={!fullEditor || chatTask?.agentId !== profile.id}
            actionsTarget={compactHeader ? runtimeActionsTarget : undefined} disabled={locked || disabled}
            chatTask={fullEditor && chatTask?.agentId === profile.id ? chatTask : null} onBackToChats={onBackToChats}
            key={profile.id} agent={profile} model={registry} onStopWorker={onStopWorker}
            assigned={profile.assignments.some(assignment => assignment.workspaceRoot === registered.data?.workspaceRoot)}
            engines={state.catalog.engines} engineId={state.engineId} /> : undefined} />
      </div>}
    </section>;
  const toggleSettings = (item: SpecialistAgent) => {
    if (railMode && profile?.id === item.id) return;
    setRuntimeStatus(null); setAdvanced(false); registry?.select(profile?.id === item.id ? null : item.id);
  };
  const statusFor = (item: SpecialistAgent): HomieStatusLabel => profile?.id === item.id && active && runtimeStatus?.agentId === item.id
    ? runtimeStatus.label : !item.assignments.some(assignment => assignment.workspaceRoot === registered.data?.workspaceRoot)
      ? 'Not assigned' : homieSnapshotStatus(snapshot?.agents.filter(worker => worker.profileId === item.id) ?? [], Boolean(snapshot && !snapshot.online));
  const renderControls = (item: SpecialistAgent) => {
    const displayName = agentDisplayName(item);
    const workers = snapshot?.agents.filter(worker => worker.profileId === item.id) ?? [];
    const selected = profile?.id === item.id;
    if (compactHeader && selected) return <div className={viewStyles.workerActions} role="group" aria-label={`Homie controls: ${displayName}`}>
      <span ref={setRuntimeActionsTarget} className={viewStyles.runtimeControlSlot} />
      <ToolbarMenu key={item.id} label={`More actions: ${displayName}`} heading={displayName} disabled={locked} menuClassName={viewStyles.homieMenu}
        items={[
          ...(workers.length ? workers.map(worker => ({ id: worker.id, label: `Container · ${containerStateLabels[worker.state] ?? 'Status unknown'}`,
            icon: <Container aria-hidden="true" />, disabled: true, onSelect() {} }))
            : [{ id: 'no-container', label: 'Container · Not connected', icon: <Container aria-hidden="true" />, disabled: true, onSelect() {} }]),
          { id: 'delete', label: `Delete agent: ${displayName}`, icon: <Trash2 aria-hidden="true" />, separatorBefore: true,
            disabled: locked, onSelect: () => setDeletion(item) },
        ]} />
    </div>;
    return <div className={viewStyles.workerActions} role="group" aria-label={`Homie controls: ${displayName}`}>
      <HomieStatusIcon name={displayName} expanded={selected} controls={`homie-settings-${item.id}`} disabled={locked} onToggle={() => toggleSettings(item)}
        label={statusFor(item)} />
      {workers.map(worker => <TooltipTarget key={worker.id} content={`${worker.name} · ${worker.state}`}>
        <span className={viewStyles.containerIndicator} role="img" aria-label={`Container connection: ${worker.name}`}>
          <Container aria-hidden="true" />
        </span>
      </TooltipTarget>)}
      <TooltipButton variant="ghost" size="icon" aria-label={`Delete agent: ${displayName}`} title={`Delete ${displayName}`}
        disabled={locked} onClick={() => setDeletion(item)}><Trash2 aria-hidden="true" /></TooltipButton>
    </div>;
  };
  const renderParticipation = (item: SpecialistAgent) => {
    const candidate = participation.candidates.find(candidate => candidate.id === item.id);
    return <NeumorphicCheckbox className={viewStyles.participationCheckbox} aria-label={`Participate: ${agentDisplayName(item)}`}
      title={candidate?.existing ? 'Remove from this room' : candidate?.available ? 'Invite to this room' : 'Assign this project and an account to participate'}
      checked={participation.members.includes(item.id)} disabled={locked || participation.conflict || (!candidate?.available && !candidate?.existing)}
      onChange={event => participation.toggle(item.id, event.target.checked)} />;
  };
  const content = <AgentManagementFrame title="Homies" icon={<Bot aria-hidden="true" />} bodyLayout="fill"
    titleContent={compactHeader && profile ? <h2 id={`homie-title-${profile.id}`} className={viewStyles.headerIdentity}>
      <TooltipTarget content={statusFor(profile)}><span className={viewStyles.statusAvatar}>
        <AgentAvatar avatar={profile.avatar} id={profile.id} />
        <HomieStatusBadge label={statusFor(profile)} name={agentDisplayName(profile)} className={viewStyles.statusBadge} />
      </span></TooltipTarget><span>{agentDisplayName(profile)}</span>
    </h2> : undefined} actions={<>
    {!compactHeader && <>
      <TooltipButton variant="ghost" size="icon" aria-label="Refresh" title="Refresh agents"
        disabled={locked || (registry ? registered.loading : changing || loading || !state.engineId)}
        onClick={() => { void registry?.refresh(); void model.refresh(); }}>
        <RefreshCw aria-hidden="true" />
      </TooltipButton>
      {registry && <>
        <TooltipButton variant="ghost" size="icon" aria-label="New agent" title="New Homie"
          disabled={!registered.data || locked} onClick={() => { setAdvanced(false); registry.select('new'); }}><Plus aria-hidden="true" /></TooltipButton>
      </>}
    </>}
    {compactHeader && profile && renderControls(profile)}
    {onClose && <TooltipButton variant="ghost" size="icon" aria-label="Close Homies" title="Close Homies" disabled={locked} onClick={onClose}><X aria-hidden="true" /></TooltipButton>}
  </>}>
    {!fullEditor && !creating && <LiquidGlassPanel as="aside" className={viewStyles.sidebar} aria-label="Agents">
      <nav ref={listScrollbar} className={viewStyles.agentList} data-detail={railMode || undefined} aria-label={railMode ? "Selected Homie" : "Agent selection"}>
        {registered.loading && !registered.data && <p className={viewStyles.empty}>Loading agents…</p>}
        {registered.error && !editing && <p className={viewStyles.empty} role="alert">{registered.error}</p>}
        {registered.data?.agents.filter(item => !railMode || item.id === profile?.id).map(item => {
          const displayName = agentDisplayName(item);
          const selected = profile?.id === item.id;
          return <div key={item.id} className={railMode ? viewStyles.selectedHomie : undefined}>
            {!railMode && <div className={viewStyles.agentRow} data-selected={selected ? 'true' : undefined}>
              {participation.room && renderParticipation(item)}
              <TooltipButton variant="ghost" className={viewStyles.agent}
                id={`homie-toggle-${item.id}`}
                aria-label={displayName} title={displayName} disabled={locked}
                aria-expanded={selected} aria-controls={`homie-settings-${item.id}`}
                onClick={() => toggleSettings(item)}>
                <AgentAvatar avatar={item.avatar} id={item.id} /><span className={viewStyles.agentName}>{displayName}</span>
              </TooltipButton>
              {renderControls(item)}
            </div>}
            {selected && <div id={`homie-settings-${item.id}`} className={viewStyles.inlineSettings} data-fill={railMode || undefined} role="region" aria-labelledby={`homie-${railMode ? 'title' : 'toggle'}-${item.id}`}>
              {editor}
            </div>}
          </div>;
        })}
        {participation.room && participation.candidates.filter(item => !registered.data?.agents.some(agent => agent.id === item.id)).map(item =>
          <div key={item.id} className={viewStyles.agentRow}>
            <NeumorphicCheckbox className={viewStyles.participationCheckbox} aria-label={`Participate: ${item.name}`} checked={participation.members.includes(item.id)} disabled={locked || participation.conflict}
              onChange={event => participation.toggle(item.id, event.target.checked)} />
            <span className={viewStyles.empty}>{item.name} · Unavailable</span>
          </div>)}
        <div className={viewStyles.notice}>
          {railMode && !profile && Boolean(registered.data?.agents.length) && <p className={viewStyles.empty}>Choose a Homie from the rail.</p>}
          {registered.data?.agents.length === 0 && <p className={viewStyles.empty}>Create a Homie to begin.</p>}
          <AgentManagementNotice state={state} />
        </div>
      </nav>
      {selectionRequest?.roomId && <section ref={connectParticipationBackdrop} className={viewStyles.participation} aria-label="Room participation">
        {participation.loading && <p>Loading participants…</p>}
        {participation.room && <>
          <span className={viewStyles.roomName}>{participation.room.name}</span>
          {railMode && profile && <label className={viewStyles.participationChoice}>
            {renderParticipation(profile)}<span>Participate: {agentDisplayName(profile)}</span>
          </label>}
          <label>Default Homie<LiquidGlassSelect ariaLabel="Default Homie" value={participation.defaults.some(item => item.id === participation.owner) ? participation.owner : ''}
            triggerAppearance="standard" menuAppearance="toolbar" menuBlurSourceRef={menuBlurSourceRef} menuBlurSourceMode="replace"
            placeholder="Choose a participating Homie" options={participation.defaults.map(item => ({ value: item.id, label: item.name }))}
            disabled={locked || participation.conflict || !participation.defaults.length} onChange={participation.setOwner} /></label>
          <p>Changes apply when saved. Removing a participant keeps its past messages and does not delete the Homie.</p>
          <NeumorphicButton variant="standard" disabled={locked || !participation.canSave} onClick={() => { void participation.save(); }}>
            {participation.saving ? 'Saving…' : 'Save participants'}
          </NeumorphicButton>
        </>}
        {participation.conflict && <><p role="alert">Participants changed. Reload before saving.</p>
          <NeumorphicButton variant="ghost" onClick={participation.reset}>Reload participants</NeumorphicButton></>}
        {participation.error && <p role="alert">{participation.error}</p>}
      </section>}
    </LiquidGlassPanel>}
    {(fullEditor || creating) && editor}
    {deletion && registry && <WorkerDeleteDialog kind="agent" name={agentDisplayName(deletion)} onClose={() => setDeletion(null)}
      onDelete={async deleteData => {
        await registry.remove({ id: deletion.id, revision: deletion.revision, deleteData });
        drafts.current.delete(deletion.id); setAdvanced(false); await model.refresh();
      }} />}
  </AgentManagementFrame>;
  if (!fullEditor && listTarget !== undefined) return listTarget ? createPortal(content, listTarget) : null;
  return content;
}
