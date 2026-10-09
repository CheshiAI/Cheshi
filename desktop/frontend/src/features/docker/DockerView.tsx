import { Box, Logs, Play, RefreshCw, RotateCw, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LiquidGlassPanel, LiquidGlassSelect } from '../../shared/ui';
import { DockerIcon } from '../../shared/ui/DockerIcon';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { AgentManagementFrame, AgentManagementNotice } from '../../shared/agent-management/AgentManagementFrame';
import type { AgentScreenProps } from '../../shared/agent-management/AgentManagementFrame';
import styles from '../../shared/agent-management/agentManagement.module.css';
import viewStyles from './DockerView.module.css';
import { ContainerTerminal } from './ContainerTerminal';
import { workerDisplayName } from '../../shared/agent-management/workerDisplayName';
import { WorkerDeleteDialog } from '../../shared/agent-management/WorkerDeleteDialog';
import { workerStatusLabel } from '../../shared/agent-management/workerStatus';

export function DockerView({ model, state, profiles, onRefreshProfiles }: AgentScreenProps & {
  profiles?: readonly { id: string; name: string }[]; onRefreshProfiles?: () => void;
}) {
  const listScrollbar = useAutoHideScrollbars<HTMLElement>();
  const logScrollbar = useAutoHideScrollbars<HTMLPreElement>();
  const [mode, setMode] = useState<'logs' | 'terminal'>('logs');
  const [terminalTarget, setTerminalTarget] = useState('');
  const [deletion, setDeletion] = useState<{ id: string; engineId: string; name: string; retryDeleteData?: boolean } | null>(null);
  const { catalog, snapshot, details, changing, loading, error } = state;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Local expiry only. The existing owner retains the 10-second network poll.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const agent = snapshot?.agents.find(item => item.id === state.agentId);
  const statusLabel = (container: NonNullable<typeof agent>) => {
    const pending = state.pendingControl;
    if (changing && pending?.engineId === state.engineId && pending.agentId === container.id
      && (pending.action === 'start' || pending.action === 'restart')) return '시작 중 · 시작 요청 진행';
    return workerStatusLabel(container, container.id === state.agentId ? details : null,
      Math.max(now, Date.now()), changing || !snapshot?.online || Boolean(error));
  };
  const target = agent ? `${state.engineId}/${agent.id}` : '';
  useEffect(() => {
    if (agent?.state !== 'running') setTerminalTarget('');
    else if (mode === 'terminal') setTerminalTarget(target);
    else setTerminalTarget(current => current === target ? current : '');
  }, [target, agent?.state, mode]);
  const disabled = changing || loading || !snapshot?.online || Boolean(error) || Boolean(agent?.pendingDeletion);
  const canStop = agent?.state === 'running' && details?.ready === true && details.busy === false;
  const engineStatus = loading ? 'Refreshing…' : snapshot?.online ? 'Engine connected' : 'Engine offline';
  return <AgentManagementFrame title="Docker" icon={<DockerIcon />} bodyLayout="fill" actions={<>
      {snapshot?.online === true && <span className={styles.description} role="status">connected</span>}
      <LiquidGlassSelect className={styles.headerEngineSelect} ariaLabel="Execution engine" title={engineStatus}
        value={state.engineId} menuAppearance="toolbar"
        triggerAppearance="standard" placeholder="Select engine" disabled={changing || catalog.engines.length === 0}
        options={catalog.engines.map(engine => ({ value: engine.id, label: engine.name,
          disabled: !engine.supported, description: engine.reason ?? undefined }))}
        onChange={id => { void model.connect(id); }} />
      <TooltipButton variant="ghost" size="icon" aria-label="Refresh" title="Refresh engines"
        disabled={changing || loading} onClick={() => { onRefreshProfiles?.(); void model.discover(); }}>
        <RefreshCw aria-hidden="true" />
      </TooltipButton>
    </>}>
    <LiquidGlassPanel as="aside" className={viewStyles.sidebar} aria-label="Containers">
      <div className={viewStyles.sidebarHeading}>
        <h2 className={styles.sectionTitle}>CONTAINERS</h2>
        <div className={styles.actions} role="group" aria-label="Container view">
          <TooltipButton size="icon" variant="ghost" aria-label="Terminal" title="Container terminal"
            aria-pressed={mode === 'terminal'} disabled={!agent || agent.state !== 'running'}
            onClick={() => { setTerminalTarget(target); setMode('terminal'); }}><SquareTerminal aria-hidden="true" /></TooltipButton>
          <TooltipButton size="icon" variant="ghost" aria-label="Logs" title="Container logs"
            aria-pressed={mode === 'logs'} onClick={() => setMode('logs')}><Logs aria-hidden="true" /></TooltipButton>
        </div>
      </div>
      <nav ref={listScrollbar} className={viewStyles.containerList} aria-label="Container selection">
        <div className={viewStyles.notice}><AgentManagementNotice state={state} /></div>
        {snapshot?.agents.map(container => <TooltipButton key={container.id} variant="ghost"
          className={viewStyles.container} aria-label={workerDisplayName(container, profiles)} title={`${container.name} · ${statusLabel(container)}\nDocker: ${container.state}`}
          aria-current={container.id === state.agentId ? 'page' : undefined} disabled={changing}
          onClick={() => { void model.select(container.id); }}>
          <Box aria-hidden="true" /><span className={viewStyles.containerName}>{workerDisplayName(container, profiles)}</span>
        </TooltipButton>)}
      </nav>
    </LiquidGlassPanel>
    <section className={viewStyles.logsPane} aria-label={mode === 'logs' ? 'Container logs' : 'Container console'}>
      {agent ? <>
        <div className={viewStyles.logHeader} aria-label="Container status">
          <div className={viewStyles.identity}>
            <TooltipTarget content={`${agent.name}\nImage: ${agent.image}\nDocker: ${agent.state}`}>
              <h2 className={viewStyles.name}>{workerDisplayName(agent, profiles)}</h2>
            </TooltipTarget>
            <span className={styles.description} role="status">{statusLabel(agent)}</span>
          </div>
          <div className={styles.actions}>
            <TooltipButton variant="ghost" size="icon" aria-label="Delete selected container" title="Delete container"
              disabled={changing || !snapshot?.online} onClick={() => setDeletion({ id: agent.id, engineId: state.engineId,
                name: workerDisplayName(agent, profiles), retryDeleteData: agent.pendingDeletion?.deleteData })}>
              <Trash2 aria-hidden="true" /></TooltipButton>
            <TooltipButton variant="ghost" size="icon" aria-label="Start" title="Start container"
              disabled={disabled || !['created', 'exited'].includes(agent.state)}
              onClick={() => { void model.control('start'); }}><Play aria-hidden="true" /></TooltipButton>
            <TooltipButton variant="ghost" size="icon" aria-label="Stop" title="Stop container" disabled={disabled || !canStop}
              onClick={() => { void model.control('stop'); }}><Square aria-hidden="true" /></TooltipButton>
            <TooltipButton variant="ghost" size="icon" aria-label="Restart" title="Restart container" disabled={disabled || !canStop}
              onClick={() => { void model.control('restart'); }}><RotateCw aria-hidden="true" /></TooltipButton>
          </div>
        </div>
        {changing && <p className={viewStyles.logNotice} role="status">Applying container operation…</p>}
        {agent.pendingDeletion && <p className={viewStyles.logNotice}>Deletion is unfinished. Use Delete container to retry cleanup.</p>}
        {details?.error && <p role="alert" className={viewStyles.logNotice}>{details.error}</p>}
        <pre ref={logScrollbar} className={viewStyles.logOutput} hidden={mode !== 'logs'} aria-label="Container log output">{details?.logs || (loading ? 'Loading logs…' : 'No logs available.')}</pre>
        {terminalTarget === target && agent.state === 'running' && <ContainerTerminal key={target}
          api={model.terminal} engineId={state.engineId} agentId={agent.id} active={mode === 'terminal'} />}
        {mode === 'terminal' && agent.state !== 'running' && <p className={viewStyles.empty}>Start the container to connect to its shell.</p>}
      </> : <p className={viewStyles.empty}>Select a container to view its logs.</p>}
    </section>
    {deletion && <WorkerDeleteDialog kind="container" name={deletion.name} retryDeleteData={deletion.retryDeleteData} onClose={() => setDeletion(null)}
      onDelete={deleteData => model.remove(deletion.engineId, deletion.id, deleteData)} />}
  </AgentManagementFrame>;
}
