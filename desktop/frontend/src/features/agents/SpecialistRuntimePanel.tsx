import { agentDisplayName } from '../../../../shared/agent-registry';
import type { HomieStatusLabel } from './HomieStatusIcon';
import { createPortal } from 'react-dom';
import type { ChatTaskTarget } from '../../../../shared/agent-chats';
import { Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AgentRuntimeState } from '../../../../shared/agent-runtime';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import type { AgentDetails, AgentEngineInfo } from '../../../../shared/agent-management';
import { LiquidGlassSelect, NeumorphicButton, CodePanel } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import type { AgentRegistryModel } from './agentRegistryModel';
import { AgentTaskResults } from './AgentTaskResults';
import { ExecutionHealth } from './ExecutionHealth';
import { HomieRuntimeStatus } from './HomieRuntimeStatus';
import { runtimeStatusPresentation } from './runtimeStatusPresentation';
import styles from './AgentsView.module.css';
import shared from '../../shared/agent-management/agentManagement.module.css';

export function SpecialistRuntimePanel({ compact = false, chatTask, onBackToChats, agent, assigned, model, engines, engineId, disabled = false, onStopWorker, headerTarget, actionsTarget, onStatusChange }: {
  compact?: boolean;
  disabled?: boolean; actionsTarget?: HTMLElement | null;
  headerTarget?: HTMLElement | null; onStatusChange?(label: HomieStatusLabel | null): void;
  chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  agent: SpecialistAgent; assigned: boolean; model: AgentRegistryModel; engines: AgentEngineInfo[]; engineId: string;
  onStopWorker?(engineId: string, workerId: string): Promise<void>;
}) {
  const [engine, setEngine] = useState(chatTask?.engineId ?? engineId);
  const statusContext = JSON.stringify([agent.id, agent.revision, engine, assigned]);
  const [observedContext, setObservedContext] = useState<string | null>(null);
  const [verifiedContext, setVerifiedContext] = useState<string | null>(null);
  const [loadedDetails, setDetails] = useState<AgentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState<AgentRuntimeState['unavailable']>();
  const bindingUnavailable = useRef(false);
  const disconnected = unavailable?.kind === 'engine-unavailable';
  const notice = !assigned ? 'Assign this agent to the current project in Agent settings.'
    : unavailable && !disconnected ? unavailable.message : null;
  const blocked = !assigned || Boolean(unavailable);
  const details = notice ? null : loadedDetails;
  const revision = useRef(0), active = useRef(true), busy = useRef(false);
  const stoppable = details?.tasks.find(item => item.status === 'accepted' || item.status === 'running')
    ?? details?.tasks.find(item => item.status === 'waiting');
  const canStopWorker = Boolean(onStopWorker && details && details.agent.state === 'running'
    && !details.busy && !stoppable && !details.tasks.some(item => item.status === 'unknown')
    && !blocked && !error && !operationError && !details.error);
  const running = details?.agent.state === 'running';
  const transitioning = lifecycle === 'starting' || lifecycle === 'draining';
  const powerDisabled = disabled || pending || blocked || !engine || verifiedContext !== statusContext || transitioning
    || (running ? !canStopWorker : Boolean(details?.busy || stoppable || details?.tasks.some(item => item.status === 'unknown')));
  const recoveryTasks = (details?.tasks ?? []).filter(item => item.id === chatTask?.taskId
    || item.status !== 'completed' || Boolean(item.inspection?.integration?.candidateHash));
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; revision.current++; };
  }, []);
  useEffect(() => { if (!engine && engineId) setEngine(engineId); }, [engine, engineId]);
  useEffect(() => { if (chatTask) setEngine(chatTask.engineId); }, [chatTask]);
  const applyRuntime = (result: AgentRuntimeState) => {
    if (result.details?.ready && !result.details.error) setOperationError(null);
    setObservedContext(statusContext);
    setVerifiedContext(statusContext);
    bindingUnavailable.current = Boolean(result.unavailable && result.unavailable.kind !== 'engine-unavailable');
    setLifecycle(result.lifecycle?.phase ?? null);
    setUnavailable(result.unavailable);
    if (result.unavailable?.kind !== 'engine-unavailable') setDetails(result.details);
    setError(bindingUnavailable.current ? null : result.unavailable?.message ?? result.lifecycle?.error ?? null);
  };
  const refresh = async () => {
    if (!assigned || !active.current || bindingUnavailable.current || !engine || busy.current) return;
    const version = ++revision.current;
    try {
      const result = await model.runtime({ agentId: agent.id, engineId: engine, action: 'status' });
      if (active.current && version === revision.current) {
        applyRuntime(result);
      }
    } catch (reason) {
      if (active.current && version === revision.current) {
        setObservedContext(statusContext);
        setVerifiedContext(null);
        setError(reason instanceof Error ? reason.message : 'Could not read this agent.');
      }
    }
  };
  useEffect(() => {
    revision.current++;
    setVerifiedContext(null);
    setDetails(null); setLifecycle(null); setError(null); setOperationError(null); setPending(false); setUnavailable(undefined); bindingUnavailable.current = false; busy.current = false;
    if (!assigned) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { clearInterval(timer); revision.current++; };
  }, [agent.id, agent.revision, engine, assigned]);
  const operate = async (action: 'project-setup' | 'start' | 'stop' | 'cancel' | 'recover' | 'application-inspect', recovery?: { taskId: string; roomId: string; candidateId?: string; hash?: string }) => {
    if (busy.current || disabled || !engine || blocked || bindingUnavailable.current
      || ((action === 'start' || action === 'stop') && powerDisabled)) return;
    busy.current = true; setObservedContext(statusContext); setPending(true); setError(null); setOperationError(null);
    const version = ++revision.current;
    try {
      if (action === 'stop') {
        if (!canStopWorker || !onStopWorker || !details) return;
        await onStopWorker(engine, details.agent.id);
      }
      const result = await model.runtime({ agentId: agent.id, engineId: engine, action: action === 'stop' ? 'status' : action,
        ...(['recover', 'application-inspect'].includes(action) ? recovery : {}),
        ...(action === 'cancel' ? { taskId: stoppable?.id } : {}) });
      if (active.current && version === revision.current) {
        applyRuntime(result);
      }
    } catch (reason) {
      if (active.current && version === revision.current) setOperationError(reason instanceof Error ? reason.message : 'Could not run this agent.');
    } finally {
      if (active.current && version === revision.current) { busy.current = false; setPending(false); }
    }
  };
  const baseStatus: HomieStatusLabel = notice ? unavailable?.kind === 'agent-removed' ? 'Agent unavailable' : 'Not assigned' : pending ? 'Processing…' : disconnected ? 'Engine disconnected' : operationError || error || details?.error || lifecycle === 'error' ? 'Error' : lifecycle === 'sleeping' ? 'Sleeping' : lifecycle === 'starting' ? 'Starting…' : lifecycle === 'disabled' ? 'Manually stopped' : details?.busy || stoppable?.status === 'running' || stoppable?.status === 'accepted' ? 'Working' : stoppable?.status === 'waiting' ? 'Waiting for reply' : details?.authenticated === false ? 'Sign-in required' : details?.ready ? 'Ready' : 'Not running';
  // An unobserved runtime is not evidence of a stopped worker. Keep the list's
  // fresh observation until this binding has a response, including a failure.
  const status = runtimeStatusPresentation({ label: notice || observedContext === statusContext ? baseStatus : 'Status unknown',
    details, error: operationError || error || details?.error || null, notice });
  const reportedStatus = notice || observedContext === statusContext ? status.label : null;
  useEffect(() => { onStatusChange?.(reportedStatus); }, [onStatusChange, reportedStatus]);
  const powerLabel = running ? 'Stop worker' : 'Start agent';
  const powerButton = <TooltipButton variant="ghost" size="icon" title={powerLabel} aria-label={powerLabel} disabled={powerDisabled}
    onClick={() => { void operate(running ? 'stop' : 'start'); }}>
    {running ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
  </TooltipButton>;
  const header = <div className={styles.detailHeader} data-inline={headerTarget ? 'true' : undefined}>
      {!headerTarget && <h2 className={styles.name}>{agentDisplayName(agent)}</h2>}
      <section className={styles.runtimeSection} aria-label="Container">
        <h3>Container</h3>
        <LiquidGlassSelect ariaLabel="Agent execution engine" triggerAppearance="standard" value={engine} disabled={pending || Boolean(notice)}
          options={engines.filter(item => item.supported).map(item => ({ value: item.id, label: item.name }))}
          onChange={value => { revision.current++; setEngine(value); }} menuAppearance="toolbar" />
      </section>
      {actionsTarget === undefined && <section className={styles.runtimeSection} aria-label="Power controls">
        <h3>Power</h3>
        <div className={styles.runtimeActions}>
          {powerButton}
        </div>
      </section>}
    </div>;
  return <>
    {actionsTarget ? createPortal(powerButton, actionsTarget) : null}
    {headerTarget ? createPortal(header, headerTarget) : header}
    {compact ? <HomieRuntimeStatus status={status} /> : <div className={styles.detailBody}>
      <div className={styles.section}><HomieRuntimeStatus status={status} /></div>
      {!notice && <>
        <div className={styles.section}>
          <span className={shared.description}>{details?.authenticated ? 'Signed' : 'Not signed in'}{details?.threadId ? ` · ${details.threadId}` : ''}</span>
          {(operationError || error || details?.error)?.includes('Project setup required:') && <>
            <p className={shared.description}>Enable a writable share for this project and restart its Colima VM. All containers must be stopped first. Each Homie keeps its own file permissions.</p>
            <NeumorphicButton disabled={pending} onClick={() => { void operate('project-setup'); }}>Enable project share and restart VM</NeumorphicButton>
          </>}
          {details?.execution && <ExecutionHealth health={details.execution} unavailable={disconnected || Boolean(error || details.error)} />}
          {stoppable && <TooltipButton variant="ghost" size="icon" aria-label="Stop task" title="Stop task" disabled={pending || disconnected}
            onClick={() => { void operate('cancel'); }}><Square aria-hidden="true" /></TooltipButton>}

        </div>
        <div className={styles.recovery}>
          <AgentTaskResults key={engine} requestedTaskId={chatTask?.taskId}
            onBackToChats={chatTask ? onBackToChats : undefined} listTitle="Active tasks and recovery"
            emptyText="No active tasks or recovery items. Work history is available in Worker."
            tasks={recoveryTasks} loading={false} running={!disconnected && details?.agent.state === 'running'}
            recoveryDisabled={pending || blocked || !details?.ready || details.busy || Boolean(details.error)}
            onInspectApplication={(taskId, roomId, candidateId, hash) => { void operate('application-inspect', { taskId, roomId, candidateId, hash }); }}
            onRecover={(taskId, roomId) => { void operate('recover', { taskId, roomId }); }} />
        </div>
        <details className={styles.logs}><summary>Worker logs</summary>
          <CodePanel code={details?.logs || 'No worker logs available.'} label="Worker logs" ariaLabel="Worker log output" />
        </details>
      </>}
    </div>}
  </>;
}
