import { useHomieParticipants } from './useHomieParticipants';
import type { AgentPackage } from '../../../../shared/agent-package';
import { duplicateHomieDraft, type HomieEditorDraft } from './homieEditorDraft';
import type { AgentChatsApi, ChatTaskTarget } from '../../../../shared/agent-chats';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { SpecialistRuntimePanel } from './SpecialistRuntimePanel';
import { Bot, Container, Download, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassPanel, LiquidGlassSelect, NeumorphicButton, NeumorphicCheckbox } from '../../shared/ui';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { AgentManagementFrame, AgentManagementNotice } from '../../shared/agent-management/AgentManagementFrame';
import type { AgentScreenProps } from '../../shared/agent-management/AgentManagementFrame';
import viewStyles from './AgentsView.module.css';
import { SpecialistAgentForm } from './SpecialistAgentForm';
import type { AgentRegistryModel, AgentRegistryState } from './agentRegistryModel';
import type { CodexAccountsApi } from '../../../../shared/codex-accounts';
import { WorkerDeleteDialog } from '../../shared/agent-management/WorkerDeleteDialog';
import type { SpecialistAgent } from '../../../../shared/agent-registry';

const emptyRegistry: AgentRegistryState = { data: null, selection: null, loading: false, saving: false, error: null };
const emptySnapshot = () => emptyRegistry;
const emptySubscribe = () => () => {};

export function AgentsView({ active = true, chatTask, onBackToChats, selectionRequest, onClose, listTarget, onEditingChange, onStopWorker, model, state, registry, accountsApi, chatsApi }: AgentScreenProps & {
  active?: boolean; chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  selectionRequest?: { agentId: string | null; roomId?: string }; onClose?(): void;
  listTarget?: HTMLElement | null; onEditingChange?(editing: boolean): void;
  onStopWorker?(engineId: string, workerId: string): Promise<void>;
  chatsApi?: AgentChatsApi;
  registry?: AgentRegistryModel | null; accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedPackage, setImportedPackage] = useState<AgentPackage | null>(null);
  const [newDraftVersion, setNewDraftVersion] = useState(0);
  const drafts = useRef(new Map<string, HomieEditorDraft>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
  const creating = registered.selection === 'new';
  const profile = creating ? undefined : registered.data?.agents.find(item => item.id === registered.selection);
  const editing = creating || Boolean(profile);
  useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
  const listScrollbar = useAutoHideScrollbars<HTMLElement>();
  const menuBlurSourceRef = useRef<HTMLElement | null>(null);
  const connectParticipationBackdrop = useCallback((element: HTMLElement | null) => {
    // Include sidebar and status-bar borders behind the portalled menu.
    menuBlurSourceRef.current = element?.closest<HTMLElement>('.app-shell') ?? null;
  }, []);
  const { snapshot, changing, loading } = state;
  const locked = registered.saving || editorBusy || importing || participation.saving;
  const importPack = async () => {
    if (!registry || locked) return;
    setImporting(true); setImportError(null);
    try {
      const definition = await registry.importPackage();
      if (definition && alive.current) {
        const installed = await registry.installPackage(definition);
        if (alive.current) {
          drafts.current.delete('new'); setImportedPackage(installed); setNewDraftVersion(value => value + 1);
          setAdvanced(false); registry.select('new');
        }
      }
    } catch (error) { if (alive.current) setImportError(error instanceof Error ? error.message : 'Could not import Homie pack.'); }
    finally { if (alive.current) setImporting(false); }
  };
  const content = <AgentManagementFrame title="Homies" icon={<Bot aria-hidden="true" />} bodyLayout="fill" actions={<>
    <TooltipButton variant="ghost" size="icon" aria-label="Refresh" title="Refresh agents"
      disabled={locked || (registry ? registered.loading : changing || loading || !state.engineId)}
      onClick={() => { void registry?.refresh(); void model.refresh(); }}>
      <RefreshCw aria-hidden="true" />
    </TooltipButton>
    {registry && <>
      {!editing && listTarget !== undefined
        ? <TooltipButton variant="ghost" size="icon" aria-label="Import Homie pack" title={importing ? 'Importing…' : 'Import Homie pack'} disabled={!registered.data || locked} onClick={() => { void importPack(); }}><Download aria-hidden="true" /></TooltipButton>
        : <NeumorphicButton variant="ghost" disabled={!registered.data || locked} onClick={() => { void importPack(); }}><Download aria-hidden="true" />{importing ? 'Importing…' : 'Import Homie pack'}</NeumorphicButton>}
      <TooltipButton variant="ghost" size="icon" aria-label="New agent" title="New Homie"
        disabled={!registered.data || locked} onClick={() => { setAdvanced(false); registry.select('new'); }}><Plus aria-hidden="true" /></TooltipButton>
    </>}
    {onClose && <TooltipButton variant="ghost" size="icon" aria-label="Close Homies" title="Close Homies" disabled={locked} onClick={onClose}><X aria-hidden="true" /></TooltipButton>}
  </>}>
    {!editing && <LiquidGlassPanel as="aside" className={viewStyles.sidebar} aria-label="Agents">
      <nav ref={listScrollbar} className={viewStyles.agentList} aria-label="Agent selection">
        {registered.loading && !registered.data && <p className={viewStyles.empty}>Loading agents…</p>}
        {registered.error && !editing && <p className={viewStyles.empty} role="alert">{registered.error}</p>}
        {registered.data?.agents.map(item => {
          const workers = snapshot?.agents.filter(worker => worker.profileId === item.id) ?? [];
          const selected = profile?.id === item.id;
          const candidate = participation.candidates.find(candidate => candidate.id === item.id);
          return <div key={item.id} className={viewStyles.agentRow} data-selected={selected ? 'true' : undefined}>
            {participation.room && <NeumorphicCheckbox className={viewStyles.participationCheckbox} aria-label={`Participate: ${item.name}`}
              title={candidate?.existing ? 'Remove from this room' : candidate?.available ? 'Invite to this room' : 'Assign this project and an account to participate'}
              checked={participation.members.includes(item.id)} disabled={locked || participation.conflict || (!candidate?.available && !candidate?.existing)}
              onChange={event => participation.toggle(item.id, event.target.checked)} />}
            <TooltipButton variant="ghost" className={viewStyles.agent}
              aria-label={item.name} title={item.name} disabled={locked}
              aria-current={selected ? 'page' : undefined} onClick={() => { setAdvanced(false); registry?.select(item.id); }}>
              <AgentAvatar avatar={item.avatar} id={item.id} /><span className={viewStyles.agentName}>{item.name}</span>
            </TooltipButton>
            <div className={viewStyles.workerActions}>
              {workers.map(worker => <TooltipTarget key={worker.id} content={`${worker.name} · ${worker.state}`}>
                <span className={viewStyles.containerIndicator} role="img" aria-label={`Container connection: ${worker.name}`}>
                  <Container aria-hidden="true" />
                </span>
              </TooltipTarget>)}
              <TooltipButton variant="ghost" size="icon" aria-label={`Delete agent: ${item.name}`} title={`Delete ${item.name}`}
                disabled={locked} onClick={() => setDeletion(item)}><Trash2 aria-hidden="true" /></TooltipButton>
            </div>
          </div>;
        })}
        {participation.room && participation.candidates.filter(item => !registered.data?.agents.some(agent => agent.id === item.id)).map(item =>
          <div key={item.id} className={viewStyles.agentRow}>
            <NeumorphicCheckbox className={viewStyles.participationCheckbox} aria-label={`Participate: ${item.name}`} checked={participation.members.includes(item.id)} disabled={locked || participation.conflict}
              onChange={event => participation.toggle(item.id, event.target.checked)} />
            <span className={viewStyles.empty}>{item.name} · Unavailable</span>
          </div>)}
        {registered.data?.agents.length === 0 && <p className={viewStyles.empty}>Create a Homie to begin.</p>}
        <div className={viewStyles.notice}><AgentManagementNotice state={state} /></div>

      </nav>
      {selectionRequest?.roomId && <section ref={connectParticipationBackdrop} className={viewStyles.participation} aria-label="Room participation">
        {participation.loading && <p>Loading participants…</p>}
        {participation.room && <>
          <span className={viewStyles.roomName}>{participation.room.name}</span>
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
    {editing && <section className={viewStyles.detailsPane} aria-label="Agent details">
      {registry && registered.data && <div className={viewStyles.settingsPane}>
        <SpecialistAgentForm engineId={state.engineId} key={`${profile?.id ?? 'new'}-${newDraftVersion}`} agent={profile} model={registry} state={registered} importing={importing}
          draft={drafts.current.get(profile?.id ?? 'new')} initialPackage={creating ? importedPackage : null}
          onSaved={creating ? () => { drafts.current.delete('new'); setImportedPackage(null); } : undefined}
          onReload={() => { drafts.current.delete(profile?.id ?? 'new'); setNewDraftVersion(value => value + 1); }}
          onDraft={draft => drafts.current.set(profile?.id ?? 'new', draft)} onBusy={setEditorBusy}
          onDelete={profile ? () => setDeletion(profile) : undefined}
          onDuplicate={profile ? draft => {
            drafts.current.set('new', duplicateHomieDraft(draft)); setImportedPackage(null);
            setNewDraftVersion(value => value + 1); setAdvanced(false); registry.select('new');
          } : undefined}
          accountsApi={accountsApi} roomId={selectionRequest?.roomId} onBack={() => registry.select(null)} runtimeRequested={advanced}
          runtime={profile && active ? (onSettings, headerTarget) => <SpecialistRuntimePanel headerTarget={headerTarget}
            chatTask={chatTask?.agentId === profile.id ? chatTask : null} onBackToChats={onBackToChats}
            key={profile.id} agent={profile} model={registry} onStopWorker={onStopWorker}
            assigned={profile.assignments.some(assignment => assignment.workspaceRoot === registered.data?.workspaceRoot)}
            engines={state.catalog.engines} engineId={state.engineId} onSettings={onSettings} /> : undefined} />
      </div>}
    </section>}
    {importError && <p role="alert" className={viewStyles.empty}>{importError}</p>}
    {deletion && registry && <WorkerDeleteDialog kind="agent" name={deletion.name} onClose={() => setDeletion(null)}
      onDelete={async deleteData => {
        await registry.remove({ id: deletion.id, revision: deletion.revision, deleteData });
        drafts.current.delete(deletion.id); setAdvanced(false); await model.refresh();
      }} />}
  </AgentManagementFrame>;
  if (!editing && listTarget !== undefined) return listTarget ? createPortal(content, listTarget) : null;
  return content;
}
