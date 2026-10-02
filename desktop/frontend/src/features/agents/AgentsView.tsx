import { Bot, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { LiquidGlassPanel, LiquidGlassSelect, NeumorphicButton } from '../../shared/ui';
import { AgentManagementFrame, AgentManagementNotice, ManagedWorkerSelect } from '../../shared/agent-management/AgentManagementFrame';
import type { AgentScreenProps } from '../../shared/agent-management/AgentManagementFrame';
import styles from '../../shared/agent-management/agentManagement.module.css';

export function AgentsView({ model, state, onOpenDocker }: AgentScreenProps & { onOpenDocker(): void }) {
  const { snapshot, details, changing, loading } = state;
  const agent = snapshot?.agents.find(item => item.id === state.agentId);
  const [taskId, setTaskId] = useState('');
  const task = details?.tasks.find(item => item.id === taskId) ?? details?.tasks[0];
  return <AgentManagementFrame title="Agents" icon={<Bot aria-hidden="true" />}>
    <div className={styles.toolbar}>
      <span className={styles.description}>Engine: {state.catalog.engines.find(item => item.id === state.engineId)?.name ?? 'Not selected'}</span>
      <NeumorphicButton variant="ghost" onClick={onOpenDocker}>Docker settings</NeumorphicButton>
      <NeumorphicButton variant="ghost" disabled={changing || loading || !state.engineId} onClick={() => { void model.refresh(); }}>
        <RefreshCw aria-hidden="true" />Refresh
      </NeumorphicButton>
      {loading && <span className={styles.description} role="status">Refreshing…</span>}
    </div>
    <AgentManagementNotice state={state} />
    <ManagedWorkerSelect model={model} state={state} label="Agent" />
    {agent && <>
      <LiquidGlassPanel as="section" className={styles.panel} aria-label="Agent status">
        <div className={styles.titleRow}><h2 className={styles.sectionTitle}>VERIFICATION AGENT</h2>
          <span>{details?.busy ? 'Working' : details?.ready ? 'Ready' : 'Unavailable'}</span></div>
        <dl className={styles.facts}>
          <dt>Login</dt><dd>{details?.authenticated === true ? 'Signed in' : details?.authenticated === false ? 'Sign in through the worker CLI' : 'Unavailable'}</dd>
          <dt>Conversation</dt><dd>{details?.threadId ?? 'No active conversation'}</dd>
        </dl>
        {agent.state !== 'running' && <p className={styles.description}>Start this agent's container in Docker to read its saved conversation and task results.</p>}
        {details?.error && <p role="alert" className={styles.description}>{details.error}</p>}
      </LiquidGlassPanel>
      <LiquidGlassPanel as="section" className={styles.panel} aria-label="Task results">
        <div className={styles.titleRow}><h2 className={styles.sectionTitle}>RECENT TASK RESULTS</h2></div>
        {details?.tasks.length ? <>
          <LiquidGlassSelect ariaLabel="Task result" value={task?.id ?? ''} menuAppearance="toolbar" triggerAppearance="standard"
            options={details.tasks.map(item => ({ value: item.id, label: `${item.id} · ${item.status}` }))} onChange={setTaskId} />
          {task && <><p className={styles.description}>{task.status} · {task.createdAt}</p>
            <p className={styles.prompt}>{task.prompt}</p><pre className={styles.output}>{task.output || task.error || 'No output yet.'}</pre></>}
        </> : <p className={styles.description}>{agent.state === 'running' ? 'No task results available.' : 'Start the worker to read its stored task results.'}</p>}
      </LiquidGlassPanel>
    </>}
  </AgentManagementFrame>;
}
