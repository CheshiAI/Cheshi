import { ArrowLeft, MessagesSquare, Plus, Users } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LiquidGlassPanel, LiquidGlassSelect, NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import type { AgentChatsApi, ChatsRequest, ChatsSnapshot, ChatTaskTarget, RoomMessage } from '../../../../shared/agent-chats';
import type { AgentRegistryApi, SpecialistAgent } from '../../../../shared/agent-registry';
import type { AgentEngineInfo, AgentManagementApi } from '../../../../shared/agent-management';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { GoalQuestions } from './GoalQuestions';
import { RoomDialog } from './RoomDialog';
import styles from './ChatsView.module.css';

export function ChatsView({ active, onOpenTask, onOpenAgents, api = cheshiDesktop?.agentChats,
  registry = cheshiDesktop?.agentRegistry, management = cheshiDesktop?.agentManagement }: {
  active: boolean; onOpenTask(target: ChatTaskTarget): void; onOpenAgents(): void;
  api?: AgentChatsApi; registry?: Pick<AgentRegistryApi, 'list' | 'onDidChange'>; management?: Pick<AgentManagementApi, 'engines'>;
}) {
  const [snapshot, setSnapshot] = useState<ChatsSnapshot>({ rooms: [], messages: [] });
  const [roomId, setRoomId] = useState<string | null>(null), [threadId, setThreadId] = useState<string | null>(null);
  const [agents, setAgents] = useState<SpecialistAgent[]>([]), [engines, setEngines] = useState<AgentEngineInfo[]>([]);
  const [dialog, setDialog] = useState<'new' | 'participants' | null>(null), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [sending, setSending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [recipient, setRecipient] = useState('default'), [goal, setGoal] = useState(false);
  const version = useRef(0), alive = useRef(true);
  const inspecting = useRef(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const sidebar = useAutoHideScrollbars<HTMLElement>(), timeline = useAutoHideScrollbars<HTMLDivElement>();
  const summaryScroll = useAutoHideScrollbars<HTMLElement>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current++; }; }, []);
  useEffect(() => {
    if (!active || !api) return;
    let stopped = false, busy = false;
    const refresh = async () => {
      if (busy) return; busy = true;
      const requestVersion = ++version.current;
      try {
        const data = await api.request({ action: 'list' });
        if (!stopped && requestVersion === version.current) { setSnapshot(data); setError(null); setRoomId(id => id ?? data.rooms[0]?.id ?? null); }
      } catch (e) { if (!stopped && requestVersion === version.current) setError(e instanceof Error ? e.message : 'Could not load Chats.'); }
      finally { busy = false; if (!stopped) setLoading(false); }
    };
    setLoading(true); void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { stopped = true; clearInterval(timer); version.current++; };
  }, [active, api]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const update = () => { void registry?.list().then(data => {
      if (!stopped) setAgents(data.agents.filter(a => a.accountId && a.assignments.some(x => x.workspaceRoot === data.workspaceRoot)));
    }, () => { if (!stopped) setError('Agent catalog is unavailable.'); }); };
    update(); const unsubscribe = registry?.onDidChange(update);
    void management?.engines().then(data => { if (!stopped) setEngines(data.engines); }, () => { if (!stopped) setError('Engine catalog is unavailable.'); });
    return () => { stopped = true; unsubscribe?.(); };
  }, [active, registry, management]);
  const room = snapshot.rooms.find(r => r.id === roomId), root = snapshot.messages.find(m => m.id === threadId && m.roomId === roomId);
  const draftKey = `${roomId}/${threadId ?? ''}`, draft = drafts[draftKey] ?? '';
  const scrollNode = useRef<HTMLDivElement | null>(null), scrollPositions = useRef(new Map<string, { top: number; pinned: boolean }>());
  const attachTimeline = useCallback((node: HTMLDivElement | null) => { scrollNode.current = node; return timeline(node); }, [timeline]);
  const visibleCount = snapshot.messages.filter(m => m.roomId === roomId && (m.threadId === threadId || m.id === threadId)).length;
  useLayoutEffect(() => {
    const node = scrollNode.current;
    if (!active || !node) return;
    const position = scrollPositions.current.get(draftKey);
    node.scrollTop = !position || position.pinned ? node.scrollHeight : position.top;
  }, [active, draftKey, visibleCount]);
  const owner = root?.recipient ?? room?.defaultAgentId;
  const goalState = root?.goalProgress;
  const needsRecovery = root?.status !== 'completed' && (root?.status === 'blocked' || root?.status === 'unknown'
    || goalState?.phase === 'blocked' || goalState?.phase === 'unknown');
  const ownerSelected = recipient === 'default' || recipient === owner;
  const recoveryBlock = needsRecovery ? goalState ? goalState.resumeBlocked : 'Checking the saved goal and worker state.' : null;
  const resumeGoal = needsRecovery && ownerSelected && !recoveryBlock;
  async function mutate(request: ChatsRequest) {
    if (!api) throw new Error('Restart the desktop app to load Chats.');
    version.current++;
    const data = await api.request(request);
    if (alive.current) { version.current++; setSnapshot(data); if (request.action === 'create') { setRoomId(request.id); setThreadId(null); } }
  }
  async function inspectExecution() {
    if (!room || !root || sending || inspecting.current) return;
    inspecting.current = true; setSending(true); setError(null);
    try { await mutate({ action: 'recover', roomId: room.id, goalId: root.id }); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Execution inspection failed.'); }
    finally { inspecting.current = false; if (alive.current) setSending(false); }
  }
  async function changeQuestion(questionId: string, change: { action: 'question'; recipient: string | null } | { action: 'question-deadline'; expiresAt: string | null }) {
    if (!room || !root || sending || inspecting.current) return;
    inspecting.current = true; setSending(true); setError(null);
    try { await mutate({ ...change, roomId: room.id, goalId: root.id, questionId }); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Question change failed. Refresh before retrying.'); }
    finally { inspecting.current = false; if (alive.current) setSending(false); }
  }
  async function send() {
    if (!room || sending || !draft.trim()) return;
    const selectedRoom = room, selectedThread = threadId, text = draft.trim();
    let to = recipient === 'default' ? null : recipient;
    // A leading @name is explicit routing; the selector disambiguates names without parsing prose mentions.
    if (text.startsWith('@')) {
      const mention = selectedRoom.members.find(m => text.startsWith(`@${m.name} `) || text === `@${m.name}`);
      if (!mention) { setError('Choose an invited agent in the recipient menu for this @mention.'); return; }
      to = mention.id;
    }
    if (needsRecovery && (to === null || to === owner) && recoveryBlock) { setError(recoveryBlock); return; }
    const key = JSON.stringify([room.id, selectedThread, to, text, goal]);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    const id = pending.current.id;
    setSending(true); setError(null);
    try {
      await mutate({ action: 'send', id, roomId: room.id, threadId: selectedThread, recipient: to, text, goal: !selectedThread && goal });
      if (!alive.current) return;
      setDrafts(all => ({ ...all, [draftKey]: all[draftKey]?.trim() === text ? '' : all[draftKey] ?? '' }));
      if (goal && !selectedThread) setThreadId(id);
      setGoal(false); pending.current = null;
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Message was not saved.'); }
    finally { if (alive.current) setSending(false); }
  }
  const name = (id: string | null) => id === 'user' ? 'You' : room?.members.find(m => m.id === id)?.name ?? id ?? '';
  function renderMessage(message: RoomMessage) {
    const agent = agents.find(a => a.id === message.sender);
    const taskAgent = message.sender === 'user' || message.kind !== 'message' ? message.recipient : message.sender;
    // Peer messages refer to the owner's task, not the recipient's consultation task.
    const owningJob = snapshot.messages.find(m => m.sender === 'user' && m.taskId === message.taskId && m.roomId === room?.id);
    return <article className={styles.message} key={message.id}>
      <div className={styles.avatar}>{message.sender === 'user' ? <MessagesSquare aria-hidden="true" /> : <AgentAvatar id={message.sender} avatar={agent?.avatar} />}</div>
      <div className={styles.messageBody}>
        <div className={styles.metadata}><strong>{name(message.sender)}</strong>{message.recipient && <span>→ {name(message.recipient)}</span>}<time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span>{message.status}</span></div>
        {message.kind !== 'message' && <span className={styles.description}>{message.kind.replaceAll('_', ' ')}</span>}
        <p className={styles.text}>{message.text || 'No text response.'}</p>
        {message.error && <p role="status" className={styles.description}>{message.error}</p>}
        <div className={styles.links}>
          {message.kind === 'goal' && <NeumorphicButton variant="ghost" onClick={() => { setThreadId(message.id); setRecipient('default'); setGoal(false); }}>Open goal thread · {snapshot.messages.filter(m => m.threadId === message.id).length}</NeumorphicButton>}
          {room && message.taskId && <NeumorphicButton variant="ghost" onClick={() => { setThreadId(message.kind === 'goal' ? message.id : message.threadId); onOpenTask({ roomId: room.id, threadId: message.kind === 'goal' ? message.id : message.threadId, agentId: owningJob?.recipient ?? taskAgent ?? room.defaultAgentId, engineId: room.engineId, taskId: message.taskId! }); }}>Task details</NeumorphicButton>}
        </div>
      </div>
    </article>;
  }
  return <main className={styles.root} hidden={!active} aria-label="Agent chats">
    <LiquidGlassPanel as="aside" className={styles.sidebar}>
      <header className={styles.header}><h2>CHATS</h2><TooltipButton variant="ghost" size="icon" title="New room" aria-label="New room" onClick={() => setDialog('new')} disabled={!api}><Plus aria-hidden="true" /></TooltipButton></header>
      <nav ref={sidebar} className={styles.roomList} aria-label="Rooms">
        {snapshot.rooms.map(r => <NeumorphicButton variant="ghost" className={styles.room} disabled={sending} key={r.id} aria-current={r.id === roomId ? 'page' : undefined} onClick={() => { setRoomId(r.id); setThreadId(null); setRecipient('default'); setGoal(false); }}><MessagesSquare aria-hidden="true" /><span>{r.name}</span></NeumorphicButton>)}
        {!snapshot.rooms.length && <p className={styles.empty}>{loading ? 'Loading rooms…' : 'Create a room and invite your agents to begin.'}</p>}
      </nav>
      <NeumorphicButton variant="ghost" onClick={onOpenAgents}>Manage agents and workers</NeumorphicButton>
    </LiquidGlassPanel>
    <section className={styles.conversation} aria-label={room?.name ?? 'Room conversation'}>
      <header className={styles.header}>{threadId && <TooltipButton variant="ghost" size="icon" title="Back to room" aria-label="Back to room" disabled={sending} onClick={() => { setThreadId(null); setRecipient('default'); }}><ArrowLeft aria-hidden="true" /></TooltipButton>}<h2>{threadId ? 'Goal thread' : room?.name ?? 'Chats'}</h2>
        {room && <TooltipButton variant="ghost" size="icon" title="Room participants" aria-label="Room participants" onClick={() => setDialog('participants')}><Users aria-hidden="true" /></TooltipButton>}</header>
      {room && <div className={styles.participants}>{room.members.map(m => m.name).join(' · ')}<span>Default: {name(owner ?? null)}</span></div>}
      {root && <section ref={summaryScroll} className={styles.goalSummary} aria-label="Goal progress">
        <div className={styles.metadata}><strong>Goal · {goalState?.phase ?? root.status ?? 'Checking'}</strong>
          <span>Turns: {goalState?.turns ?? 'Unknown'}</span></div>
        <p>Model tokens: {goalState?.usage ? `${goalState.usage.totalTokens.toLocaleString()} reported through turn ${goalState.usage.reportedThroughTurn}` : 'Unknown'} · Cost: Unknown</p>
        {goalState?.recovery && <p>Execution confirmed: {goalState.recovery.status} · {goalState.recovery.checkedAt}<br />Conversation: {goalState.recovery.threadId} · Turn: {goalState.recovery.turnId}</p>}
        {goalState?.progress && <p>{goalState.progress}</p>}
        {(goalState?.reason || root.error) && <p>Reason: {goalState?.reason || root.error}</p>}
        <p>Next action: {goalState?.nextAction || 'No next action recorded.'}</p>
        {room && <GoalQuestions questions={goalState?.questions ?? []}
          members={room.members.filter(m => m.id !== root.recipient && agents.some(a => a.id === m.id && a.accountId === m.accountId))}
          disabled={sending || !api || goalState?.phase !== 'waiting' || !!goalState.resumeBlocked}
          onChange={(id, recipient) => { void changeQuestion(id, { action: 'question', recipient }); }}
          onDeadline={(id, expiresAt) => { void changeQuestion(id, { action: 'question-deadline', expiresAt }); }} />}
        {needsRecovery && <p role="status">{recoveryBlock ?? 'Add the missing information below to resume the same goal. Its completion criteria and verification requirements remain in place.'}</p>}
        {(root.status === 'unknown' || goalState?.phase === 'unknown') && <NeumorphicButton variant="standard" disabled={sending || !api} onClick={() => { void inspectExecution(); }}>Check execution result</NeumorphicButton>}
      </section>}
      {error && <p className={styles.notice} role="alert">{error}</p>}
      {!api && <p className={styles.empty}>Restart the desktop app to load Chats.</p>}
      <div ref={attachTimeline} onScroll={e => { const node = e.currentTarget; scrollPositions.current.set(draftKey, { top: node.scrollTop, pinned: node.scrollHeight - node.clientHeight - node.scrollTop < 48 }); }} className={styles.timeline} key={`${roomId}/${threadId}`} aria-label="Room messages">
        {root && renderMessage(root)}
        {snapshot.messages.filter(m => m.roomId === roomId && m.threadId === threadId).map(renderMessage)}
        {room && !snapshot.messages.some(m => m.roomId === room.id) && <p className={styles.empty}>Send a message, or start a goal with clear completion conditions. Agents can ask invited peers for help and verification.</p>}
      </div>
      {room && <form className={styles.composer} onSubmit={e => { e.preventDefault(); void send(); }}>
        <div className={styles.composerControls}><LiquidGlassSelect ariaLabel="Message recipient" value={recipient} options={[{ value: 'default', label: `Default · ${name(owner ?? null)}` }, ...room.members.map(m => ({ value: m.id, label: `@${m.name}` }))]} onChange={setRecipient} disabled={sending} />
          {!threadId && <LiquidGlassSelect ariaLabel="Message type" value={goal ? 'goal' : 'message'} options={[{ value: 'message', label: 'Message' }, { value: 'goal', label: 'New goal' }]} onChange={v => setGoal(v === 'goal')} disabled={sending} />}</div>
        <NeumorphicTextField multiline variant="standard" aria-label="Message" placeholder={resumeGoal ? 'Add the missing information to resume this goal…' : goal ? 'Describe the goal and completion conditions…' : 'Message the selected agent…'} value={draft} maxLength={16000} onChange={e => setDrafts(all => ({ ...all, [draftKey]: e.target.value }))} />
        <div className={styles.actions}><NeumorphicButton variant="standard" type="submit" disabled={sending || !draft.trim() || !api || (ownerSelected && !!recoveryBlock)}>{sending ? 'Saving…' : resumeGoal ? 'Send and resume goal' : goal && !threadId ? 'Start goal' : 'Send'}</NeumorphicButton></div>
      </form>}
    </section>
    {active && dialog && <RoomDialog room={dialog === 'participants' ? room : undefined} agents={agents} engines={engines} onSave={mutate} onClose={() => setDialog(null)} />}
  </main>;
}
