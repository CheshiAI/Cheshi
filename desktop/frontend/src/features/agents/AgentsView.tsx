import type { ChatTaskTarget } from '../../../../shared/agent-chats';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { SpecialistRuntimePanel } from './SpecialistRuntimePanel';
import { Bot, Container, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { LiquidGlassPanel } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
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

export function AgentsView({ active = true, chatTask, onBackToChats, selectionRequest, onClose, onStopWorker, model, state, registry, accountsApi }: AgentScreenProps & {
  active?: boolean; chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  selectionRequest?: { agentId: string | null }; onClose?(): void;
  onStopWorker?(engineId: string, workerId: string): Promise<void>;
  registry?: AgentRegistryModel | null; accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const [advanced, setAdvanced] = useState(false);
  const openedSelection = useRef<typeof selectionRequest>(undefined);
  const [deletion, setDeletion] = useState<SpecialistAgent | null>(null);
  const registered = useSyncExternalStore(registry?.subscribe ?? emptySubscribe, registry?.snapshot ?? emptySnapshot);
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
  const listScrollbar = useAutoHideScrollbars<HTMLElement>();
  const { snapshot, changing, loading } = state;
  return <AgentManagementFrame title="Homies" icon={<Bot aria-hidden="true" />} bodyLayout="fill" actions={<>
    <TooltipButton variant="ghost" size="icon" aria-label="Refresh" title="Refresh agents"
      disabled={registered.saving || (registry ? registered.loading : changing || loading || !state.engineId)}
      onClick={() => { void registry?.refresh(); void model.refresh(); }}>
      <RefreshCw aria-hidden="true" />
    </TooltipButton>
    {!editing && registry && <TooltipButton variant="ghost" size="icon" aria-label="New agent" title="New Homie"
      disabled={!registered.data || registered.saving} onClick={() => { setAdvanced(false); registry.select('new'); }}><Plus aria-hidden="true" /></TooltipButton>}
    {onClose && <TooltipButton variant="ghost" size="icon" aria-label="Close Homies" title="Close Homies" disabled={registered.saving} onClick={onClose}><X aria-hidden="true" /></TooltipButton>}
  </>}>
    {!editing && <LiquidGlassPanel as="aside" className={viewStyles.sidebar} aria-label="Agents">
      <nav ref={listScrollbar} className={viewStyles.agentList} aria-label="Agent selection">
        {registered.loading && !registered.data && <p className={viewStyles.empty}>Loading agents…</p>}
        {registered.error && !editing && <p className={viewStyles.empty} role="alert">{registered.error}</p>}
        {registered.data?.agents.map(item => {
          const workers = snapshot?.agents.filter(worker => worker.profileId === item.id) ?? [];
          const selected = profile?.id === item.id;
          return <div key={item.id} className={viewStyles.agentRow} data-selected={selected ? 'true' : undefined}>
            <TooltipButton variant="ghost" className={viewStyles.agent}
              aria-label={item.name} title={item.name} disabled={registered.saving}
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
                disabled={registered.saving} onClick={() => setDeletion(item)}><Trash2 aria-hidden="true" /></TooltipButton>
            </div>
          </div>;
        })}
        {registered.data?.agents.length === 0 && <p className={viewStyles.empty}>Create a Homie to begin.</p>}
        <div className={viewStyles.notice}><AgentManagementNotice state={state} /></div>

      </nav>
    </LiquidGlassPanel>}
    {editing && <section className={viewStyles.detailsPane} aria-label="Agent details">
      {registry && registered.data && <div className={viewStyles.settingsPane} hidden={advanced}>
        <SpecialistAgentForm key={profile?.id ?? 'new'} agent={profile} model={registry} state={registered}
          accountsApi={accountsApi} onBack={() => registry.select(null)}
          onAdvanced={profile ? () => setAdvanced(true) : undefined} />
      </div>}
      {advanced && active && registry && profile && <SpecialistRuntimePanel
        chatTask={chatTask?.agentId === profile.id ? chatTask : null} onBackToChats={onBackToChats}
        key={profile.id} agent={profile} model={registry} onStopWorker={onStopWorker}
        assigned={profile.assignments.some(assignment => assignment.workspaceRoot === registered.data?.workspaceRoot)}
        engines={state.catalog.engines} engineId={state.engineId} onSettings={() => setAdvanced(false)} />}
    </section>}
    {deletion && registry && <WorkerDeleteDialog kind="agent" name={deletion.name} onClose={() => setDeletion(null)}
      onDelete={async deleteData => {
        await registry.remove({ id: deletion.id, revision: deletion.revision, deleteData });
        setAdvanced(false); await model.refresh();
      }} />}
  </AgentManagementFrame>;
}
