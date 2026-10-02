import { SpecialistRuntimePanel } from './SpecialistRuntimePanel';
import { Bot, Plus, RefreshCw } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { LiquidGlassPanel } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { AgentManagementFrame, AgentManagementNotice } from '../../shared/agent-management/AgentManagementFrame';
import type { AgentScreenProps } from '../../shared/agent-management/AgentManagementFrame';
import styles from '../../shared/agent-management/agentManagement.module.css';
import viewStyles from './AgentsView.module.css';
import { AgentTaskResults } from './AgentTaskResults';
import { SpecialistAgentForm } from './SpecialistAgentForm';
import type { AgentRegistryModel, AgentRegistryState } from './agentRegistryModel';
import type { CodexAccountsApi } from '../../../../shared/codex-accounts';

const emptyRegistry: AgentRegistryState = { data: null, selection: null, loading: false, saving: false, error: null };
const emptySnapshot = () => emptyRegistry;
const emptySubscribe = () => () => {};

export function AgentsView({ model, state, registry, accountsApi }: AgentScreenProps & {
  registry?: AgentRegistryModel | null; accountsApi?: Pick<CodexAccountsApi, 'list' | 'onDidChange'>;
}) {
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const registered = useSyncExternalStore(registry?.subscribe ?? emptySubscribe, registry?.snapshot ?? emptySnapshot);
  const profile = registered.data?.agents.find(item => item.id === registered.selection);
  const editing = Boolean(registry && registered.data && (registered.selection === 'new' || profile));
  const listScrollbar = useAutoHideScrollbars<HTMLElement>();
  const { snapshot, details, changing, loading } = state;
  const agent = snapshot?.agents.find(item => item.id === state.agentId);
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
          disabled={!registered.data || registered.saving} onClick={() => registry.select('new')}><Plus aria-hidden="true" /></TooltipButton>}
      </div>
      <nav ref={listScrollbar} className={viewStyles.agentList} aria-label="Agent selection">
        {registered.loading && !registered.data && <p className={viewStyles.empty}>Loading agents…</p>}
        {registered.error && !editing && <p className={viewStyles.empty} role="alert">{registered.error}</p>}
        {registered.data?.agents.map(item => <TooltipButton key={item.id} variant="ghost" className={viewStyles.agent}
          aria-label={item.name} title={item.name} disabled={registered.saving}
          aria-current={registered.selection === item.id ? 'page' : undefined} onClick={() => registry?.select(item.id)}>
          <Bot aria-hidden="true" /><span className={viewStyles.agentName}>{item.name}</span>
        </TooltipButton>)}
        {registry && Boolean(snapshot?.agents.length) && <h3 className={`${styles.sectionTitle} ${viewStyles.workerHeading}`}>CONNECTED WORKER CONTAINERS</h3>}
        <div className={viewStyles.notice}><AgentManagementNotice state={state} /></div>
        {snapshot?.agents.map(worker => <TooltipButton key={worker.id} variant="ghost"
          className={viewStyles.agent} aria-label={worker.name} title={worker.name}
          aria-current={!editing && worker.id === state.agentId ? 'page' : undefined} disabled={changing || registered.saving}
          onClick={() => { registry?.select(null); void model.select(worker.id); }}>
          <Bot aria-hidden="true" /><span className={viewStyles.agentName}>{worker.name}</span>
        </TooltipButton>)}
      </nav>
    </LiquidGlassPanel>
    <section className={viewStyles.detailsPane} aria-label="Agent details">
      {editing && registry && profile && runtimeId === profile.id ? <SpecialistRuntimePanel key={profile.id} agent={profile} model={registry}
        engines={state.catalog.engines} engineId={state.engineId} onSettings={() => setRuntimeId(null)} /> : editing && registry ? <SpecialistAgentForm key={registered.selection} agent={profile} model={registry} state={registered} accountsApi={accountsApi} onOpen={profile ? () => setRuntimeId(profile.id) : undefined} /> : agent ? <>
        <div className={viewStyles.detailHeader} aria-label="Agent status">
          <TooltipTarget content={agent.name}><h2 className={viewStyles.name}>{agent.name}</h2></TooltipTarget>
          <span className={styles.description}>{details?.busy ? 'Working' : details?.ready ? 'Ready' : 'Unavailable'}</span>
          <div className={`${viewStyles.sessionMeta} ${styles.description}`}>
            <span className={viewStyles.login}>{details?.authenticated === true ? 'Signed' : details?.authenticated === false ? 'Not signed in' : 'Login unavailable'}</span>
            <span aria-hidden="true">·</span>
            <TooltipTarget content={details?.threadId ?? 'No active conversation'}>
              <span className={viewStyles.conversation} aria-label="Conversation">{details?.threadId ?? 'No active conversation'}</span>
            </TooltipTarget>
          </div>
        </div>
        <div className={viewStyles.detailBody}>
          {(agent.state !== 'running' || details?.error) && <div className={viewStyles.section}>
            {agent.state !== 'running' && <p className={styles.description}>Start this agent's container in Docker to read its saved conversation and task results.</p>}
            {details?.error && <p role="alert" className={styles.description}>{details.error}</p>}
          </div>}
          <AgentTaskResults key={`${state.engineId}/${agent.id}`} tasks={details?.tasks ?? []}
            loading={loading} running={agent.state === 'running'} />
        </div>
      </> : <p className={viewStyles.empty}>Select an agent to view its status and task results.</p>}
    </section>
  </AgentManagementFrame>;
}
