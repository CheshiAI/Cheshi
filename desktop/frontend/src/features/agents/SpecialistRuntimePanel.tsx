import type { ChatTaskTarget } from '../../../../shared/agent-chats';
import { Play, RefreshCw, Settings, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import type { AgentDetails, AgentEngineInfo } from '../../../../shared/agent-management';
import { LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import type { AgentRegistryModel } from './agentRegistryModel';
import { AgentTaskResults } from './AgentTaskResults';
import styles from './AgentsView.module.css';
import shared from '../../shared/agent-management/agentManagement.module.css';

export function SpecialistRuntimePanel({ chatTask, onBackToChats, agent, model, engines, engineId, onSettings }: {
  chatTask?: ChatTaskTarget | null; onBackToChats?(): void;
  agent: SpecialistAgent; model: AgentRegistryModel; engines: AgentEngineInfo[]; engineId: string; onSettings(): void;
}) {
  const [engine, setEngine] = useState(chatTask?.engineId ?? engineId);
  const [details, setDetails] = useState<AgentDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [prompt, setPrompt] = useState('');
  const task = useRef<{ id: string; prompt: string } | null>(null);
  const revision = useRef(0), active = useRef(true), busy = useRef(false);
  const stoppable = details?.tasks.find(item => item.status === 'accepted' || item.status === 'running')
    ?? details?.tasks.find(item => item.status === 'waiting');
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; revision.current++; };
  }, []);
  useEffect(() => { if (!engine && engineId) setEngine(engineId); }, [engine, engineId]);
  useEffect(() => { if (chatTask) setEngine(chatTask.engineId); }, [chatTask]);
  const refresh = async () => {
    if (!engine || busy.current) return;
    const version = ++revision.current;
    try {
      const result = await model.runtime({ agentId: agent.id, engineId: engine, action: 'status' });
      if (active.current && version === revision.current) {
        setDisconnected(Boolean(result.unavailable));
        if (!result.unavailable) setDetails(result.details);
        setError(result.unavailable?.message ?? null);
      }
    } catch (reason) {
      if (active.current && version === revision.current) setError(reason instanceof Error ? reason.message : 'Could not read this agent.');
    }
  };
  useEffect(() => {
    revision.current++;
    setDetails(null); setError(null); setPending(false); setDisconnected(false); busy.current = false; task.current = null;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { clearInterval(timer); revision.current++; };
  }, [agent.id, agent.revision, engine]);
  const operate = async (action: 'start' | 'submit' | 'cancel' | 'recover', recovery?: { taskId: string; roomId: string }) => {
    if (busy.current || !engine || disconnected) return;
    busy.current = true; setPending(true); setError(null);
    const version = ++revision.current;
    if (action === 'submit' && (!task.current || task.current.prompt !== prompt)) task.current = { id: crypto.randomUUID(), prompt };
    try {
      const result = await model.runtime({ agentId: agent.id, engineId: engine, action,
        ...(action === 'recover' ? recovery : {}),
        ...(action === 'submit' ? { taskId: task.current!.id, prompt: task.current!.prompt } : {}),
        ...(action === 'cancel' ? { taskId: stoppable?.id } : {}) });
      if (active.current && version === revision.current) {
        setDetails(result.details);
        setDisconnected(Boolean(result.unavailable)); setError(result.unavailable?.message ?? null);
        if (action === 'submit') { setPrompt(''); task.current = null; }
      }
    } catch (reason) {
      if (active.current && version === revision.current) setError(reason instanceof Error ? reason.message : 'Could not run this agent.');
    } finally {
      if (active.current && version === revision.current) { busy.current = false; setPending(false); }
    }
  };
  return <>
    <div className={styles.detailHeader}>
      <h2 className={styles.name}>{agent.name}</h2>
      <span className={shared.description}>{pending ? 'Processing…' : disconnected ? 'Engine disconnected' : details?.busy ? 'Working' : stoppable?.status === 'waiting' ? 'Waiting for reply' : details?.ready ? 'Ready' : 'Not running'}</span>
      <div className={styles.runtimeActions}>
        <LiquidGlassSelect ariaLabel="Agent execution engine" triggerAppearance="standard" value={engine} disabled={pending}
          options={engines.filter(item => item.supported).map(item => ({ value: item.id, label: item.name }))}
          onChange={value => { revision.current++; setEngine(value); }} menuAppearance="toolbar" />
        <TooltipButton variant="ghost" size="icon" title="Start agent" aria-label="Start agent" disabled={pending || disconnected || !engine || details?.busy}
          onClick={() => { void operate('start'); }}><Play aria-hidden="true" /></TooltipButton>
        <TooltipButton variant="ghost" size="icon" title="Refresh agent" aria-label="Refresh agent" disabled={pending || !engine}
          onClick={() => { void refresh(); }}><RefreshCw aria-hidden="true" /></TooltipButton>
        <TooltipButton variant="ghost" size="icon" title="Agent settings" aria-label="Agent settings" disabled={pending} onClick={onSettings}><Settings aria-hidden="true" /></TooltipButton>
      </div>
    </div>
    <div className={styles.detailBody}>
      <div className={styles.section}>
        <span className={shared.description}>{details?.authenticated ? 'Signed' : 'Not signed in'}{details?.threadId ? ` · ${details.threadId}` : ''}</span>
        {(error || details?.error) && <p className={shared.description} role="alert">{error || details?.error}</p>}
        <form className={styles.taskComposer} onSubmit={event => { event.preventDefault(); void operate('submit'); }}>
          <NeumorphicTextField multiline rows={3} variant="standard" aria-label="Agent task" placeholder="Give this agent a task"
            value={prompt} maxLength={20_000} disabled={pending} onChange={event => setPrompt(event.target.value)} />
          <div className={styles.runtimeActions}>
            {stoppable && <TooltipButton type="button" variant="ghost" size="icon" aria-label="Stop task" title="Stop task" disabled={pending || disconnected}
              onClick={() => { void operate('cancel'); }}><Square aria-hidden="true" /></TooltipButton>}
            <NeumorphicButton variant="standard" type="submit" disabled={pending || disconnected || !details?.ready || !details.authenticated || details.busy || !prompt.trim()}>Run task</NeumorphicButton>
          </div>
        </form>
      </div>
      <AgentTaskResults requestedTaskId={chatTask?.taskId} onBackToChats={chatTask ? onBackToChats : undefined} key={engine} tasks={details?.tasks ?? []} loading={false} running={!disconnected && details?.agent.state === 'running'}
        recoveryDisabled={pending || disconnected || !details?.ready || details.busy || Boolean(details.error)}
        onRecover={(taskId, roomId) => { void operate('recover', { taskId, roomId }); }} />
    </div>
  </>;
}
