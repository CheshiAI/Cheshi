import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { SpecialistRuntimePanel } from './SpecialistRuntimePanel';
import { Bot, Container, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { LiquidGlassPanel } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { AgentManagementFrame, AgentManagementNotice } from '../../shared/agent-management/AgentManagementFrame';
import type { AgentScreenProps } from '../../shared/agent-management/AgentManagementFrame';
import styles from '../../shared/agent-management/agentManagement.module.css';
import viewStyles from './AgentsView.module.css';
import { SpecialistAgentForm } from './SpecialistAgentForm';
import type { AgentRegistryModel, AgentRegistryState } from './agentRegistryModel';
import type { CodexAccountsApi } from '../../../../shared/codex-accounts';
import { WorkerDeleteDialog } from '../../shared/agent-management/WorkerDeleteDialog';
import type { SpecialistAgent } from '../../../../shared/agent-registry';

const emptyRegistry: AgentRegistryState = { data: null, selection: null, loading: false, saving: false, error: null };
const emptySnapshot = () => emptyRegistry;
const emptySubscribe = () => () => {};

export function AgentsView({ model, state, registry, accountsApi }: AgentScreenProps & {
  registry?: AgentRegistryModel | null; accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<SpecialistAgent | null>(null);
  const registered = useSyncExternalStore(registry?.subscribe ?? emptySubscribe, registry?.snapshot ?? emptySnapshot);
  const creating = registered.selection === 'new';
  const profile = creating ? undefined : registered.data?.agents.find(item => item.id === registered.selection) ?? registered.data?.agents[0];
  const editing = creating || Boolean(profile && settingsId === profile.id);
  const listScrollbar = useAutoHideScrollbars<HTMLElement>();
  const { snapshot, changing, loading } = state;
  return <AgentManagementFrame title="Agents" icon={<Bot aria-hidden="true" />} bodyLayout="fill" actions={
    <TooltipButton variant="ghost" size="icon" aria-label="Refresh" title="Refresh agents"
      disabled={registered.saving || (registry ? registered.loading : changing || loading || !state.engineId)}
      onClick={() => { void registry?.refresh(); void model.refresh(); }}>
      <RefreshCw aria-hidden="true" />
    </TooltipButton>
  }>
    <LiquidGlassPanel as="aside" className={viewStyles.sidebar} aria-label="Agents">
      <div className={viewStyles.sidebarHeading}><h2 className={styles.sectionTitle}>AGENTS</h2>
        {registry && <TooltipButton className={viewStyles.createButton} variant="ghost" size="icon" aria-label="New agent" title="New agent"
          disabled={!registered.data || registered.saving} onClick={() => { setSettingsId(null); registry.select('new'); }}><Plus aria-hidden="true" /></TooltipButton>}
      </div>
      <nav ref={listScrollbar} className={viewStyles.agentList} aria-label="Agent selection">
        {registered.loading && !registered.data && <p className={viewStyles.empty}>Loading agents…</p>}
        {registered.error && !editing && <p className={viewStyles.empty} role="alert">{registered.error}</p>}
        {registered.data?.agents.map(item => {
          const workers = snapshot?.agents.filter(worker => worker.profileId === item.id) ?? [];
          const selected = profile?.id === item.id;
          return <div key={item.id} className={viewStyles.agentRow} data-selected={selected ? 'true' : undefined}>
            <TooltipButton variant="ghost" className={viewStyles.agent}
              aria-label={item.name} title={item.name} disabled={registered.saving}
              aria-current={selected ? 'page' : undefined} onClick={() => { setSettingsId(null); registry?.select(item.id); }}>
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
        <div className={viewStyles.notice}><AgentManagementNotice state={state} /></div>

      </nav>
    </LiquidGlassPanel>
    <section className={viewStyles.detailsPane} aria-label="Agent details">
      {registry && registered.data && editing ? <SpecialistAgentForm key={profile?.id ?? 'new'} agent={profile}
        model={registry} state={registered} accountsApi={accountsApi} onBack={profile ? () => setSettingsId(null) : undefined} />
        : registry && profile ? <SpecialistRuntimePanel key={profile.id} agent={profile} model={registry}
          engines={state.catalog.engines} engineId={state.engineId} onSettings={() => setSettingsId(profile.id)} />
        : <p className={viewStyles.empty}>Select an agent to view its status and task results.</p>}
    </section>
    {deletion && registry && <WorkerDeleteDialog kind="agent" name={deletion.name} onClose={() => setDeletion(null)}
      onDelete={async deleteData => {
        await registry.remove({ id: deletion.id, revision: deletion.revision, deleteData });
        setSettingsId(current => current === deletion.id ? null : current); await model.refresh();
      }} />}
  </AgentManagementFrame>;
}
