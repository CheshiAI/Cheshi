import { ChevronRight, RefreshCw, Users } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LiquidGlassPanel, LoadingIndicator, NeumorphicButton } from '../../shared/ui';
import { agentCacheRate, createAgentDetailsLoader, type AgentDetails } from './agentDetailsModel';
import { CommandActivity } from './CommandActivity';
import { MessageContent } from './MessageContent';
import type { ChatActivityItem, ChatTimelineItem } from './model';
import styles from './AgentActivity.module.css';

interface AgentEnvironment {
  active: boolean;
  streaming: boolean;
  load: (ids: string[]) => Promise<AgentDetails[]>;
}
const AgentContext = createContext<AgentEnvironment | null>(null);

export function AgentActivityProvider({ contextId, threadId, active, streaming, children }: {
  contextId?: string; threadId: string | null; active: boolean; streaming: boolean; children: ReactNode;
}) {
  const load = useMemo(() => createAgentDetailsLoader(async ids => {
    if (!threadId || !cheshiDesktop?.readCodexAgentDetails) throw new Error('Agent details are unavailable. Restart Cheshi.');
    return cheshiDesktop.readCodexAgentDetails(threadId, ids, contextId);
  }), [contextId, threadId]);
  const value = useMemo(() => ({ load, active, streaming }), [load, active, streaming]);
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

function TokenUsage({ agent }: { agent: AgentDetails }) {
  const usage = agent.usage;
  if (!usage) return <p className={styles.muted}>Usage information unavailable.</p>;
  const number = (value: number | null) => value === null ? 'Not available' : value.toLocaleString('en-US');
  return <section aria-label="Agent token usage">
    <strong>Agent cumulative usage</strong>
    <dl className={styles.usage}>
      <div><dt>Input</dt><dd>{number(usage.inputTokens)}</dd></div>
      <div><dt>Cached input</dt><dd>{number(usage.cachedInputTokens)}</dd></div>
      <div><dt>Cache reuse</dt><dd>{agentCacheRate(usage)}</dd></div>
      <div><dt>Cache write</dt><dd>{number(usage.cacheWriteInputTokens)}</dd></div>
      <div><dt>Output</dt><dd>{number(usage.outputTokens)}</dd></div>
      <div><dt>Reasoning (within output)</dt><dd>{number(usage.reasoningOutputTokens)}</dd></div>
    </dl>
    <p className={styles.muted}>Cumulative for this agent, including earlier work. Cached tokens are part of input.</p>
  </section>;
}

function AgentWorkItem({ item }: { item: ChatTimelineItem }) {
  if (item.kind === 'activity') {
    if (item.activity === 'command') return <CommandActivity item={item} />;
    return <details className={styles.workItem}>
      <summary>{item.label} · {item.status}</summary>
      <p className={styles.prompt}>{item.detail}</p>
      {item.changes?.map(change => <div key={change.path}><strong>{change.path}</strong><pre>{change.diff}</pre></div>)}
    </details>;
  }
  return <details className={styles.workItem}>
    <summary>{item.kind === 'user' ? 'Task / input' : item.kind === 'reasoning' ? 'Reasoning summary'
      : item.kind === 'plan' ? 'Plan' : 'Agent message'}</summary>
    <MessageContent text={item.text} />
  </details>;
}

export function AgentDetailsContent({ agents }: { agents: AgentDetails[] }) {
  return <>{agents.map(agent => <section className={styles.agent} key={agent.id} aria-label={`Details for ${agent.title}`}>
    <div className={styles.metadata}>
      <strong>{agent.title}</strong><span>{agent.status}</span>
      <span>Model: {agent.model ?? 'Not available'} · Effort: {agent.reasoningEffort ?? 'Not available'}</span>
    </div>
    <TokenUsage agent={agent} />
    <strong>Work history</strong>
    {agent.omittedItems > 0 && <p className={styles.muted}>Showing the latest 100 items. {agent.omittedItems} earlier items are available through /agent.</p>}
    {agent.items.length ? <div className={styles.history}>{agent.items.map(item => <AgentWorkItem key={item.id} item={item} />)}</div>
      : <p className={styles.muted}>No work history available yet.</p>}
  </section>)}</>;
}

export function AgentActivity({ item }: { item: ChatActivityItem }) {
  const environment = useContext(AgentContext);
  const [expanded, setExpanded] = useState(false);
  const [agents, setAgents] = useState<AgentDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const idsKey = JSON.stringify(item.agent?.threadIds ?? []);
  const load = environment?.load;
  const active = environment?.active ?? false;
  const streaming = environment?.streaming ?? false;

  useEffect(() => {
    setAgents([]);
    setError(null);
  }, [idsKey, load]);

  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    if (!expanded || !active || !load || ids.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      setLoading(true);
      try {
        const details = await load(ids);
        if (cancelled) return;
        setAgents(details);
        setError(null);
        if (streaming || details.some(agent => agent.status === 'active' || agent.status === 'inProgress')) {
          timer = setTimeout(() => void refresh(), 5000);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load agent details.');
      } finally { if (!cancelled) setLoading(false); }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [expanded, active, load, idsKey, streaming, revision]);

  return <LiquidGlassPanel className={styles.card} data-liquid-glass-backdrop="true">
    <details onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className={styles.summary}>
        <Users aria-hidden="true" />
        <span className={styles.heading}><strong>{item.label}</strong><span>{item.agent?.tool ?? item.detail}</span></span>
        <span className={styles.muted}>{item.status}</span>
        <ChevronRight className={styles.chevron} aria-hidden="true" />
      </summary>
      {expanded && <div className={styles.content}>
        {item.agent?.agentPath && <p className={styles.prompt}>{item.agent.agentPath}</p>}
        {item.agent?.prompt && <section><strong>Assigned task</strong><p className={styles.prompt}>{item.agent.prompt}</p></section>}
        {item.agent?.model && <p className={styles.muted}>Requested model: {item.agent.model} · Effort: {item.agent.reasoningEffort ?? 'Not available'}</p>}
        {item.agent?.threadIds.length ? <>
          <div className={styles.refresh}>
            <strong>Agent details</strong>
            {loading && <LoadingIndicator label="Loading agent details" />}
            <NeumorphicButton raised className="sidebar-heading-action" aria-label="Refresh agent details" disabled={loading || !active}
              onClick={() => setRevision(value => value + 1)}><RefreshCw aria-hidden="true" /></NeumorphicButton>
          </div>
          {error && <p role="alert">{error}</p>}
          {!environment && <p className={styles.muted}>Agent details are unavailable in this view. Open /agent to inspect the conversation.</p>}
          <AgentDetailsContent agents={agents} />
        </> : <p className={styles.muted}>This record has no linked agent thread. Work history and usage information are unavailable.</p>}
      </div>}
    </details>
  </LiquidGlassPanel>;
}
