import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Phone, Reply, Users, X } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { NeumorphicButton, NeumorphicTextField } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { MessageContent } from '../chat/MessageContent';
import { ChatMessageLabel } from '../chat/ChatMessageLabel';
import { isWorkKind } from '../../../../shared/agent-work';
import { VerificationMessage } from '../agents/VerificationMessage';
import { WorkMessage } from '../agents/WorkMessage';
import type { AgentChatsApi, ChatsRequest, RoomMessage } from '../../../../shared/agent-chats';
import { resolveChatRecipient } from '../../../../shared/agent-chat-recipient';
import type { AgentRegistryApi, SpecialistAgent } from '../../../../shared/agent-registry';
import type { AgentEngineInfo, AgentManagementApi } from '../../../../shared/agent-management';
import { useChatsSnapshot } from './useChatsSnapshot';
import { ChatsRoomList } from './ChatsRoomList';
import { VoiceDialog } from './VoiceDialog';
import { RoomDialog } from './RoomDialog';
import { RoomWorkState } from './RoomWorkState';
import { ExecutionRecord } from './ExecutionRecord';
import { currentWork, exchangeLabel, messageRoot, workLabel } from './roomTimeline';
import styles from './ChatsView.module.css';
import { useRoomTimeline } from './useRoomTimeline';

const ChatsMessageContent = memo(MessageContent);

export function ChatsView({ active, sidebarTarget, sidebarActive = false, onOpenRoom, onOpenAgents, api = cheshiDesktop?.agentChats,
  registry = cheshiDesktop?.agentRegistry, management = cheshiDesktop?.agentManagement }: {
  active: boolean; sidebarTarget?: HTMLElement | null; sidebarActive?: boolean; onOpenRoom?(): void; onOpenAgents(): void;
  api?: AgentChatsApi; registry?: Pick<AgentRegistryApi, 'list' | 'onDidChange'>; management?: Pick<AgentManagementApi, 'engines'>;
}) {
  const data = useChatsSnapshot(api, active || sidebarActive), { snapshot } = data;
  const [roomId, setRoomId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, string | null>>({});
  const [agents, setAgents] = useState<SpecialistAgent[]>([]), [engines, setEngines] = useState<AgentEngineInfo[]>([]);
  const [dialog, setDialog] = useState<'new' | 'participants' | null>(null), [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false), [voiceOpen, setVoiceOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const alive = useRef(true), sendingRef = useRef(false), composing = useRef(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const timeline = useAutoHideScrollbars<HTMLDivElement>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!data.loaded || snapshot.rooms.some(room => room.id === roomId)) return;
    setRoomId(snapshot.rooms[0]?.id ?? null);
  }, [data.loaded, snapshot.rooms, roomId]);
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
  const room = snapshot.rooms.find(r => r.id === roomId), messages = useRoomTimeline(snapshot.messages, roomId);
  const replyMessage = messages.find(m => m.id === replies[roomId ?? '']);
  const candidate = replyMessage && messageRoot(replyMessage, messages);
  const root = candidate && (candidate.kind === 'goal' || candidate.dialogue) ? candidate : undefined;
  const threadId = root?.id ?? null;
  const draftKey = roomId ?? '', draft = drafts[draftKey] ?? '';
  const scrollNode = useRef<HTMLDivElement | null>(null), scrollPositions = useRef(new Map<string, { top: number; pinned: boolean }>());
  const attachTimeline = useCallback((node: HTMLDivElement | null) => { scrollNode.current = node; return timeline(node); }, [timeline]);
  const visibleCount = messages.length;
  useLayoutEffect(() => {
    const node = scrollNode.current;
    if (!active || !node) return;
    const position = scrollPositions.current.get(draftKey);
    node.scrollTop = !position || position.pinned ? node.scrollHeight : position.top;
    const resize = new ResizeObserver(() => {
      const current = scrollPositions.current.get(draftKey);
      if (!current || current.pinned) node.scrollTop = node.scrollHeight;
    });
    if (node.firstElementChild) resize.observe(node.firstElementChild);
    return () => resize.disconnect();
  }, [active, draftKey, visibleCount]);
  const owner = root?.recipient ?? room?.defaultAgentId, goalState = root?.goalProgress;
  const needsRecovery = root?.status !== 'completed' && (root?.status === 'blocked' || root?.status === 'unknown'
    || goalState?.phase === 'blocked' || goalState?.phase === 'unknown');
  const messageText = draft.trim();
  const addressing = resolveChatRecipient(messageText, room?.members ?? [], replyMessage);
  const recipient = addressing.recipient;
  const ownerSelected = recipient !== null && recipient === owner;
  const mentionChoices = messageText.startsWith('@') && !recipient
    ? room?.members.filter(member => member.name.toLocaleLowerCase().startsWith(messageText.slice(1).toLocaleLowerCase())) ?? [] : [];
  const recoveryBlock = needsRecovery ? goalState ? goalState.resumeBlocked : 'Checking the saved goal and worker state.' : null;
  const resumeGoal = needsRecovery && ownerSelected && !recoveryBlock;
  const working = currentWork(messages);
  const userQuestions = messages.filter(message => message.userQuestion && !message.userQuestion.answered);
  async function mutate(request: ChatsRequest) {
    if (!api) throw new Error('Restart the desktop app to load Chats.');
    await data.request(request);
    if (alive.current && request.action === 'create') setRoomId(request.id);
  }
  async function send() {
    if (!room || sending || sendingRef.current || !draft.trim()) return;
    const text = messageText, to = recipient;
    if (addressing.error) { setError(addressing.error); return; }
    if (needsRecovery && ownerSelected && recoveryBlock) { setError(recoveryBlock); return; }
    const question = replyMessage?.userQuestion;
    const answer = question && !question.answered ? { answerTo: question.rootId, questionId: question.id } : {};
    const key = JSON.stringify([room.id, threadId, to, text, replyMessage?.id, answer]);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    sendingRef.current = true; setSending(true); setError(null);
    try {
      await mutate({ action: 'send', id: pending.current.id, roomId: room.id, threadId, recipient: to, text, goal: false, automatic: true, ...(replyMessage ? { replyTo: replyMessage.id } : {}), ...answer });
      if (!alive.current) return;
      setDrafts(all => ({ ...all, [draftKey]: all[draftKey]?.trim() === text ? '' : all[draftKey] ?? '' }));
      setReplies(all => all[room.id] === replyMessage?.id ? { ...all, [room.id]: null } : all);
      pending.current = null;
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Message was not saved.'); }
    finally { sendingRef.current = false; if (alive.current) setSending(false); }
  }
  const name = (id: string | null) => id === 'user' ? 'You' : room?.members.find(m => m.id === id)?.name ?? id ?? '';
  function renderMessage(message: RoomMessage) {
    const label = exchangeLabel(message, messages);
    const question = message.questionId && message.questionId !== message.id ? messages.find(m => m.id === message.questionId) : undefined;
    const ownRoot = messageRoot(message, messages);
    const context = messages.find(m => m.id === message.replyTo) ?? question ?? (ownRoot && ownRoot.id !== message.id && working.length > 1 ? ownRoot : undefined);
    return <article key={message.id} className={styles.message} data-message-id={message.id} data-reply-action>
      <div className={styles.messageActions}>
        <TooltipButton variant="standard" size="icon" title="Reply" aria-label={`Reply to ${(message.text || message.activity?.title || 'execution').slice(0, 80)}`}
          onClick={() => { if (room) setReplies(all => ({ ...all, [room.id]: message.id })); }}><Reply aria-hidden="true" /></TooltipButton>
      </div>
      <div className={styles.messageBody}>
        <ChatMessageLabel author={message.sender === 'user' ? 'user' : 'assistant'} name={message.sender === 'user' ? undefined : name(message.sender)}
          avatar={message.sender === 'user' ? undefined : <AgentAvatar id={message.sender} avatar={agents.find(a => a.id === message.sender)?.avatar} />}
          createdAt={Date.parse(message.createdAt) / 1000} className={styles.metadata}>
          {message.recipient && <span>→ {name(message.recipient)}</span>}{label && <span>{label}</span>}
        </ChatMessageLabel>
        {context && <blockquote className={styles.replyQuote}>{name(context.sender)}: {context.text.slice(0, 240)}</blockquote>}
        {message.activity && message.activity.kind !== 'message' ? <ExecutionRecord activity={message.activity} />
          : isWorkKind(message.kind) ? <WorkMessage kind={message.kind} text={message.text} />
            : message.kind === 'verification_request' || message.kind === 'verification_result' ? <VerificationMessage kind={message.kind} text={message.text} />
              : <div className={styles.text}><ChatsMessageContent text={message.text || 'No text response.'} /></div>}
        {message.error && !message.goalProgress && <p role="status" className={styles.description}>{message.error}</p>}
        {message.activity?.kind === 'message' && message.activity.truncated && <p className={styles.description}>Message shortened to the retained excerpt.</p>}
        {message.status === 'queued' && message.error && <div className={styles.links}>
          <NeumorphicButton variant="ghost" disabled={sending}
            onClick={async () => { setSending(true); setError(null); try { await mutate({ action: 'retry', roomId: message.roomId, messageId: message.id }); }
              catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Worker retry failed.'); }
              finally { if (alive.current) setSending(false); } }}>Retry worker</NeumorphicButton>
        </div>}
      </div>
    </article>;
  }
  const roomList = <ChatsRoomList snapshot={snapshot} selectedId={roomId} phase={data.phase} loaded={data.loaded} refreshing={data.refreshing} disabled={!api} error={data.error}
    onSelect={id => { setRoomId(id); onOpenRoom?.(); }} onNew={() => { setDialog('new'); onOpenRoom?.(); }} onRefresh={() => { void data.refresh(); }} onOpenAgents={onOpenAgents} />;
  return <>
    {sidebarTarget && createPortal(roomList, sidebarTarget)}
    <main className={styles.root} hidden={!active} aria-label="Agent chats">
      {sidebarTarget === undefined && <aside className={styles.sidebar}>{roomList}</aside>}
      <section className={styles.conversation} aria-label={room?.name ?? 'Room conversation'}>
        <header className={styles.header}>
          {room ? <div className={styles.participants} aria-label="Room participants">
            {room.members.map(member => <TooltipTarget key={member.id} content={member.name}>
              <span className={styles.participant} tabIndex={0}><AgentAvatar id={member.id} avatar={agents.find(agent => agent.id === member.id)?.avatar} /><span>{member.name}</span></span>
            </TooltipTarget>)}
          </div> : <h2>Chats</h2>}
          {room && <TooltipButton variant="ghost" size="icon" title="Phone calls" aria-label="Phone calls" onClick={() => setVoiceOpen(true)}><Phone aria-hidden="true" /></TooltipButton>}
          {room && <TooltipButton variant="ghost" size="icon" title="Room participants" aria-label="Room participants" onClick={() => setDialog('participants')}><Users aria-hidden="true" /></TooltipButton>}
        </header>
        {error && <p className={styles.notice} role="alert">{error}</p>}
        {!api && <p className={styles.empty}>Restart the desktop app to load Chats.</p>}
        <div ref={attachTimeline} onScroll={e => { const node = e.currentTarget; scrollPositions.current.set(draftKey, { top: node.scrollTop, pinned: node.scrollHeight - node.clientHeight - node.scrollTop < 48 }); }} className={styles.timeline} key={roomId} aria-label="Room messages">
          <div>{messages.map(renderMessage)}</div>
          {room && !messages.length && <p className={styles.empty}>Mention an agent with @ to assign work, or reply to continue their work. Other messages stay in the room without calling an agent.</p>}
        </div>
        {room && <div className={styles.activityBar} aria-label="Current agent activity" role="status">
          {working.map(work => <span key={`${work.recipient}/${work.taskId}`} title={work.goalProgress?.reason || work.error || work.goalProgress?.resumeBlocked || work.text}>
            <AgentAvatar id={work.recipient!} avatar={agents.find(a => a.id === work.recipient)?.avatar} />
            {name(work.recipient)} · {workLabel(work)}{working.length > 1 && ` · ${work.text.slice(0, 60)}`}
          </span>)}
        </div>}
        {room && <form aria-label="Room composer" className={styles.composer} onSubmit={e => { e.preventDefault(); void send(); }}>
          {!replyMessage && userQuestions.length > 0 && <div className={styles.links} aria-label="Questions for you">
            {userQuestions.map(question => <NeumorphicButton key={question.id} variant="standard" type="button"
              onClick={() => { setReplies(all => ({ ...all, [room.id]: question.id })); }}>
              {name(question.sender)} · Needs your answer
            </NeumorphicButton>)}
          </div>}
          {root && room && <RoomWorkState message={root} room={room} agents={agents} mutate={mutate} />}
          {recoveryBlock && <p role="status" className={styles.description}>{recoveryBlock}</p>}
          {replyMessage && <div className={styles.replyContext} aria-label="Reply context"><span>Replying to {name(replyMessage.sender)}: {replyMessage.text.slice(0, 160)}</span>
            <TooltipButton variant="ghost" size="icon" title="Cancel reply" aria-label="Cancel reply" onClick={() => setReplies(all => ({ ...all, [room.id]: null }))}><X aria-hidden="true" /></TooltipButton></div>}
          <p className={styles.description} aria-label="Delivery target" role="status">{addressing.error ?? (recipient ? `To: ${name(recipient)}` : 'Room message · Mention an agent with @ to call them')}</p>
          {mentionChoices.length > 0 && <div className={styles.links} aria-label="Mention suggestions">
            {mentionChoices.map(member => <NeumorphicButton key={member.id} type="button" variant="standard"
              onClick={() => { setDrafts(all => ({ ...all, [draftKey]: `@${member.name} ` })); setError(null); composerInput.current?.focus(); }}>
              @{member.name}
            </NeumorphicButton>)}
          </div>}
          <NeumorphicTextField ref={composerInput} multiline variant="standard" aria-label="Message" placeholder={resumeGoal ? 'Add the missing information to resume this goal…' : 'Message the room, or @mention an agent…'} value={draft} maxLength={16000}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
                || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault(); void send();
            }} onChange={e => setDrafts(all => ({ ...all, [draftKey]: e.target.value }))} />
          <div className={styles.actions}><NeumorphicButton variant="standard" type="submit" disabled={sending || !draft.trim() || !api || (ownerSelected && !!recoveryBlock)}>{sending ? 'Saving…' : resumeGoal ? 'Send and resume goal' : 'Send'}</NeumorphicButton></div>
        </form>}
      </section>
      {active && dialog && <RoomDialog room={dialog === 'participants' ? room : undefined} agents={agents} engines={engines} onSave={mutate} onClose={() => setDialog(null)} />}
      {active && voiceOpen && room && <VoiceDialog key={room.id} roomId={room.id} onClose={() => setVoiceOpen(false)} />}
    </main>
  </>;
}
