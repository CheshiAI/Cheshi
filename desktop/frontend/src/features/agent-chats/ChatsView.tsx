import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, Phone, Plus, X } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { EmptyState, NeumorphicButton, RegionalBlur, SlidingSidePanel } from '../../shared/ui';
import { SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import { WorkerIcon } from '../../shared/ui/WorkerIcon';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import { AgentAvatar } from '../../shared/agent-management/AgentAvatar';
import { syncChatComposerOverlayHeight } from '../chat/chatComposerOverlay';
import { WorkspaceLayoutControls } from '../shell/WorkspaceLayoutControls';
import { verificationReview, verificationReportContext, type VerificationReview } from './verificationReviewModel';
import { isRoomWorkSettled, type AgentChatsApi, type ChatsRequest, type RoomMessage } from '../../../../shared/agent-chats';
import { resolveChatRecipient, resolveRoomMemberNames } from '../../../../shared/agent-chat-recipient';
import { agentDisplayName, type AgentRegistryApi } from '../../../../shared/agent-registry';
import { DELETED_HOMIE, useRoomAgents } from './useRoomAgents';
import type { AgentEngineInfo, AgentManagementApi } from '../../../../shared/agent-management';
import { useChatsSnapshot } from './useChatsSnapshot';
import { ChatsRoomList } from './ChatsRoomList';
import { DeleteRoomDialog } from './DeleteRoomDialog';
import { VoiceDialog } from './VoiceDialog';
import { RoomDialog } from './RoomDialog';
import { ChatsComposer } from './ChatsComposer';
import { RoomWorkState } from './RoomWorkState';
import { fileChangesItem } from './fileChanges';
import type { ChatActivityItem } from '../chat/model';
import { messageRoot } from './roomTimeline';
import { ChatsTimeline } from './ChatsTimeline';
import styles from './ChatsView.module.css';
import { useRoomTimeline } from './useRoomTimeline';
import { useChatsScroll } from './useChatsScroll';

export function ChatsView({ active, sidebarTarget, sidebarActive = false, onOpenRoom, onCloseWorkspace, onManageHomies, homiesOpen = false, selectedHomieId, homiesBusy = false, onHomiesTarget, onCloseHomies, reviewedMessageId, onReviewFileChanges, reviewedVerificationId, onReviewVerification, api = cheshiDesktop?.agentChats,
  registry = cheshiDesktop?.agentRegistry, management = cheshiDesktop?.agentManagement }: {
  active: boolean; sidebarTarget?: HTMLElement | null; sidebarActive?: boolean; onOpenRoom?(): void; onCloseWorkspace?(): void; onManageHomies?(agentId?: string, roomId?: string): void;
  homiesOpen?: boolean; selectedHomieId?: string | null; homiesBusy?: boolean; onHomiesTarget?(target: HTMLDivElement | null): void; onCloseHomies?(): void;
  reviewedMessageId?: string; onReviewFileChanges?: (item: ChatActivityItem | null, path?: string) => void;
  reviewedVerificationId?: string; onReviewVerification?: (review: VerificationReview | null, open?: boolean) => void;
  api?: AgentChatsApi; registry?: Pick<AgentRegistryApi, 'list' | 'onDidChange'>; management?: Pick<AgentManagementApi, 'engines'>;
}) {
  const homiesId = useId();
  const homiesContentRef = useRef<HTMLDivElement | null>(null);
  const attachHomiesTarget = useCallback((target: HTMLDivElement | null) => {
    homiesContentRef.current = target; onHomiesTarget?.(target);
  }, [onHomiesTarget]);
  useEffect(() => {
    const panel = homiesContentRef.current?.parentElement;
    if (!active || !homiesOpen || !panel) return;
    // Listen outside the portal root so its React handlers can consume Escape first.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); onCloseHomies?.();
    };
    panel.addEventListener('keydown', closeOnEscape);
    return () => panel.removeEventListener('keydown', closeOnEscape);
  }, [active, homiesOpen, onCloseHomies]);
  const toolsRailRef = useRef<HTMLElement>(null);
  const railScrollbar = useAutoHideScrollbars<HTMLDivElement>();
  const wasHomiesOpen = useRef(homiesOpen);
  useEffect(() => {
    if (active && wasHomiesOpen.current && !homiesOpen) {
      toolsRailRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"], [aria-label="New Homie"]')?.focus();
    }
    wasHomiesOpen.current = homiesOpen;
  }, [active, homiesOpen]);
  const data = useChatsSnapshot(api, active || sidebarActive), { snapshot: savedSnapshot } = data;
  const workingHomies = useMemo(() => {
    const working = new Set<string>();
    for (const message of savedSnapshot.messages) {
      // Only task anchors carry current execution state; activity rows are historical.
      if ((message.executionStatus ?? message.status) !== 'running') continue;
      const agentId = message.sender === 'user' && message.taskId
        ? message.recipient : message.relatedTask?.agentId;
      if (agentId) working.add(agentId);
    }
    return working;
  }, [savedSnapshot.messages]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, string | null>>({});
  const { agents, allAgents, status: memberStatus } = useRoomAgents(registry, active || sidebarActive);
  const snapshot = useMemo(() => ({ ...savedSnapshot,
    rooms: savedSnapshot.rooms.map(room => resolveRoomMemberNames(room, agents)),
  }), [savedSnapshot, agents]);
  const [engines, setEngines] = useState<AgentEngineInfo[]>([]);
  const [dialog, setDialog] = useState<'new' | null>(null), [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false), [voiceOpen, setVoiceOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const alive = useRef(true), sendingRef = useRef(false);
  const pending = useRef<{ key: string; id: string; roomId: string } | null>(null);
  const [pinningRoomId, setPinningRoomId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const pinning = useRef(false);
  const [deleteRoomId, setDeleteRoomId] = useState<string | null>(null);
  const deleteTarget = snapshot.rooms.find(saved => saved.id === deleteRoomId);
  const timeline = useAutoHideScrollbars<HTMLDivElement>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!data.loaded || snapshot.rooms.some(room => room.id === roomId)) return;
    setRoomId(snapshot.rooms[0]?.id ?? null);
  }, [data.loaded, snapshot.rooms, roomId]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    void management?.engines().then(data => { if (!stopped) setEngines(data.engines); }, () => { if (!stopped) setError('Engine catalog is unavailable.'); });
    return () => { stopped = true; };
  }, [active, management]);
  const room = snapshot.rooms.find(r => r.id === roomId), messages = useRoomTimeline(snapshot.messages, roomId);
  const reviewedMessage = messages.find(message => message.id === reviewedMessageId);
  const reviewedFiles = useMemo(() => reviewedMessage?.activity
    ? fileChangesItem(reviewedMessage.activity, reviewedMessage.id) : null, [reviewedMessage?.activity, reviewedMessage?.id]);
  useEffect(() => {
    if (reviewedMessageId) onReviewFileChanges?.(active ? reviewedFiles : null);
  }, [active, reviewedMessageId, reviewedFiles, onReviewFileChanges]);
  const selectedVerification = useMemo(() => {
    const message = messages.find(message => message.id === reviewedVerificationId);
    return message ? verificationReview(message, messages, verificationReportContext(message, messages, agents)) : null;
  }, [messages, reviewedVerificationId, agents]);
  useEffect(() => {
    if (reviewedVerificationId) onReviewVerification?.(active ? selectedVerification : null);
  }, [active, reviewedVerificationId, selectedVerification, onReviewVerification]);
  const replyMessage = messages.find(m => m.id === replies[roomId ?? '']);
  const candidate = replyMessage && messageRoot(replyMessage, messages);
  const root = candidate && (candidate.kind === 'goal' || candidate.dialogue) ? candidate : undefined;
  const threadId = root?.id ?? null;
  const draftKey = roomId ?? '', draft = drafts[draftKey] ?? '';
  const scrollNode = useRef<HTMLDivElement | null>(null);
  const reading = useChatsScroll(snapshot, data.loaded, roomId, active, scrollNode, messages);
  const contentRef = useRef<HTMLDivElement>(null);
  const [composerArea, setComposerArea] = useState<HTMLElement | null>(null);
  const attachTimeline = useCallback((node: HTMLDivElement | null) => { scrollNode.current = node; return timeline(node); }, [timeline]);
  useLayoutEffect(() => {
    const content = contentRef.current, area = composerArea, node = scrollNode.current;
    if (!active || !content || !area || !node) return;
    let previousHeight = 0, previousWidth = 0;
    const sync = () => {
      const height = Math.ceil(area.getBoundingClientRect().height), width = node.clientWidth;
      if (!area.isConnected || height <= 0) return;
      if (height === previousHeight && width === previousWidth) return;
      // Only the composer consumes this width. Setting it on the conversation
      // would invalidate inherited styles on every saved message.
      if (width > 0 && width !== previousWidth) area.style.setProperty('--chat-viewport-width', `${width}px`);
      if (height !== previousHeight) syncChatComposerOverlayHeight(content, height, null, false);
      previousHeight = height; previousWidth = width;
      // Restore once after all style writes; the overlay helper must not scroll a second time.
      reading.restore();
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(area); observer.observe(node);
    return () => {
      observer.disconnect();
      content.style.removeProperty('--composer-overlay-height');
      area.style.removeProperty('--chat-viewport-width');
    };
  }, [active, draftKey, composerArea]);
  const owner = root?.recipient ?? room?.defaultAgentId, goalState = root?.goalProgress;
  const needsRecovery = root?.status !== 'completed' && (root?.status === 'blocked' || root?.status === 'unknown'
    || goalState?.phase === 'blocked' || goalState?.phase === 'unknown');
  const messageText = draft.trim();
  const addressing = resolveChatRecipient(messageText, room?.members ?? [], replyMessage);
  const recipient = addressing.recipient ?? (addressing.error ? null : room?.defaultAgentId ?? null);
  const recipientBlock = recipient && room ? memberStatus(room.members.find(m => m.id === recipient), room.workspace) : null;
  const ownerSelected = recipient !== null && recipient === owner;
  const mentionChoices = messageText.startsWith('@') && !recipient
    ? room?.members.filter(member => !memberStatus(member, room.workspace) && member.name.toLocaleLowerCase().startsWith(messageText.slice(1).toLocaleLowerCase())) ?? [] : [];
  const recoveryBlock = needsRecovery ? goalState ? goalState.resumeBlocked : 'Checking the saved goal and worker state.' : null;
  const resumeGoal = needsRecovery && ownerSelected && !recoveryBlock;
  const userQuestions = messages.filter(message => message.userQuestion && !message.userQuestion.answered);
  const requestSnapshot = data.request;
  const mutate = useCallback(async (request: ChatsRequest) => {
    if (!api) throw new Error('Restart the desktop app to load Worker.');
    await requestSnapshot(request);
    if (alive.current && request.action === 'create') setRoomId(request.id);
  }, [api, requestSnapshot]);
  const reply = useCallback((message: RoomMessage) => {
    setReplies(all => ({ ...all, [message.roomId]: message.id }));
  }, []);
  const retry = useCallback(async (message: RoomMessage) => {
    setSending(true); setError(null);
    try { await mutate({ action: 'retry', roomId: message.roomId, messageId: message.id }); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Worker retry failed.'); }
    finally { if (alive.current) setSending(false); }
  }, [mutate]);
  async function send() {
    if (!room || sending || sendingRef.current || !draft.trim()) return;
    const text = messageText, to = recipient;
    if (addressing.error) { setError(addressing.error); return; }
    if (recipientBlock) { setError(recipientBlock); return; }
    if (needsRecovery && ownerSelected && recoveryBlock) { setError(recoveryBlock); return; }
    const question = replyMessage?.userQuestion;
    const answer = question && !question.answered ? { answerTo: question.rootId, questionId: question.id } : {};
    const key = JSON.stringify([room.id, threadId, to, text, replyMessage?.id, answer]);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID(), roomId: room.id };
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
  async function pinRoom(id: string, pinned: boolean) {
    if (pinning.current) return;
    pinning.current = true; setPinningRoomId(id); setPinError(null);
    try { await mutate({ action: 'pin', roomId: id, pinned }); }
    catch (e) { if (alive.current) setPinError(e instanceof Error ? e.message : 'Room pin was not saved.'); }
    finally { pinning.current = false; if (alive.current) setPinningRoomId(null); }
  }
  async function deleteRoom(id: string) {
    if (sendingRef.current) throw new Error('Wait for the pending message to be saved.');
    await mutate({ action: 'delete', roomId: id });
    if (!alive.current) return;
    setDrafts(all => { const next = { ...all }; delete next[id]; return next; });
    setReplies(all => { const next = { ...all }; delete next[id]; return next; });
    if (pending.current?.roomId === id) pending.current = null;
    if (roomId === id) { setRoomId(null); setVoiceOpen(false); setDialog(null); setError(null); }
  }
  const name = (id: string | null) => id === 'user' ? 'You' : [...(room?.members ?? []), ...(room?.formerMembers ?? [])].find(m => m.id === id)?.name ?? id ?? '';
  const roomList = <ChatsRoomList snapshot={snapshot} agents={agents} selectedId={roomId} phase={data.phase} loaded={data.loaded} refreshing={data.refreshing} disabled={!api} error={data.error ?? pinError}
    roomStatus={saved => memberStatus(saved.members.find(member => member.id === saved.defaultAgentId), saved.workspace) === DELETED_HOMIE ? 'Deleted Homie · Conversation saved' : null}
    pinningRoomId={pinningRoomId} onPin={(id, pinned) => { void pinRoom(id, pinned); }}
    onDelete={id => { setDeleteRoomId(id); onOpenRoom?.(); }}
    onRename={(roomId, name) => mutate({ action: 'rename', roomId, name })}
    onSelect={id => { setRoomId(id); onOpenRoom?.(); }} onNew={() => { setDialog('new'); onOpenRoom?.(); }} onRefresh={data.refresh} />;
  return <>
    {sidebarTarget && createPortal(roomList, sidebarTarget)}
    <main className={styles.root} hidden={!active} aria-label="Worker">
      {sidebarTarget === undefined && <aside className={styles.sidebar}>{roomList}</aside>}
      <section className={styles.conversation} aria-label={room?.name ?? 'Room conversation'}>
        <header className={styles.header}>
          {room ? <TooltipTarget content={room.name} placement="below">
            <h2 className={styles.roomTitle}>{room.name}</h2>
          </TooltipTarget> : <SidebarPanelTitle as="h2" icon={<WorkerIcon />} title="WORKER" />}
          <div className={styles.headerActions}>
            <TooltipButton variant="ghost" size="icon" title="Phone calls" aria-label="Phone calls" aria-haspopup="dialog" disabled={!room} onClick={() => setVoiceOpen(true)}><Phone aria-hidden="true" /></TooltipButton>
            <WorkspaceLayoutControls />
            {onCloseWorkspace && <TooltipButton size="icon" title="Close Worker pane" aria-label="Close Worker pane" onClick={onCloseWorkspace}><X aria-hidden="true" /></TooltipButton>}
          </div>
        </header>
        <div className={styles.body}>
          <div className={styles.content} ref={contentRef}>
            {error && <p className={styles.notice} role="alert">{error}</p>}
            {!room && <EmptyState className={styles.roomEmpty}
              title={data.phase === 'error' ? 'Could not load Worker' : !data.loaded ? 'Loading rooms…' : 'Start working with your Homies'}
              description={data.phase === 'error' ? data.error : !data.loaded ? 'Checking your work rooms.'
                : 'Select a room in Worker, or create one and invite your Homies to begin.'} />}
            <RegionalBlur sourceRef={scrollNode}>
              <div ref={attachTimeline} hidden={!room} onScroll={reading.onScroll} className={styles.timeline} key={roomId} aria-label="Room messages">
                <ChatsTimeline room={room} messages={messages} window={reading.window} agents={agents} api={api} sending={sending}
                  mutate={mutate} onReply={reply} onRetry={retry}
                  onReviewFileChanges={onReviewFileChanges} onReviewVerification={onReviewVerification} />
              </div>
              {room && reading.awayFromBottom && <div className={styles.latestMessages}>
                <NeumorphicButton variant="standard" size={reading.unreadCount ? 'standard' : 'icon'} aria-label="Jump to latest messages" title="Jump to latest messages" onClick={reading.jumpToLatest}>
                  <ArrowDown aria-hidden="true" />{reading.unreadCount > 0 && <span>{reading.unreadCount} new {reading.unreadCount === 1 ? 'message' : 'messages'}</span>}
                </NeumorphicButton>
              </div>}
              {room && <ChatsComposer key={`composer-${room.id}`} areaRef={setComposerArea} active={active} draft={draft} sending={sending} resumeGoal={resumeGoal}
                sendDisabled={sending || !draft.trim() || !api || !!addressing.error || !!recipientBlock || (ownerSelected && !!recoveryBlock)}
                onSend={() => { void send(); }} onDraftChange={text => setDrafts(all => ({ ...all, [draftKey]: text }))}
                deliveryTarget={addressing.error ?? (recipientBlock ? `${name(recipient)} · ${recipientBlock}` : recipient ? `To: ${name(recipient)}` : 'Room message · Mention an agent with @ to call them')}
                replyMessage={replyMessage} replyName={replyMessage ? name(replyMessage.sender) : ''}
                onCancelReply={() => setReplies(all => ({ ...all, [room.id]: null }))}
                mentionChoices={mentionChoices} onMention={member => { setDrafts(all => ({ ...all, [draftKey]: `@${member.name} ` })); setError(null); }}>
                {!replyMessage && userQuestions.length > 0 && <div className={styles.links} aria-label="Questions for you">
                  {userQuestions.map(question => <NeumorphicButton key={question.id} variant="standard" type="button"
                    onClick={() => { setReplies(all => ({ ...all, [room.id]: question.id })); }}>
                    {name(question.sender)} · Needs your answer
                  </NeumorphicButton>)}
                </div>}
                {root && <RoomWorkState message={root} room={room} agents={agents} mutate={mutate} />}
                {recipientBlock === DELETED_HOMIE && <p role="status" className={styles.description}>This Homie was deleted. Conversation history is preserved; tasks cannot be sent to it.</p>}
                {recoveryBlock && <p role="status" className={styles.description}>{recoveryBlock}</p>}
              </ChatsComposer>}
            </RegionalBlur>
          </div>
          <aside className={styles.inspector} aria-label="Worker panels">
            <SlidingSidePanel open={homiesOpen} stageClassName={styles.homiesStage} className={styles.homiesPanel} aria-label="Homies sidebar">
              <div id={homiesId} ref={attachHomiesTarget} className={styles.homiesPanelContent} />
            </SlidingSidePanel>
            <aside ref={toolsRailRef} className={styles.toolsRail} aria-label="Room tools">
              {onManageHomies && <>
                <div ref={railScrollbar} className={styles.homieIcons} role="navigation" aria-label="Homie selection">
                  {allAgents.map(agent => <TooltipButton key={agent.id} variant="ghost" className={styles.homieIcon}
                    data-working={workingHomies.has(agent.id) ? 'true' : undefined}
                    title={agentDisplayName(agent)} aria-label={`Open Homie: ${agentDisplayName(agent)}`}
                    aria-current={selectedHomieId === agent.id ? 'page' : undefined}
                    active={homiesOpen && selectedHomieId === agent.id} aria-expanded={homiesOpen && selectedHomieId === agent.id}
                    aria-controls={homiesId} disabled={homiesBusy} onClick={() => onManageHomies(agent.id, room?.id)}>
                    <AgentAvatar id={agent.id} avatar={agent.avatar} />
                  </TooltipButton>)}
                </div>
                <TooltipButton variant="ghost" size="icon" className={styles.homieIcon} title="New Homie"
                  aria-label="New Homie" disabled={homiesBusy} onClick={() => onManageHomies('new', room?.id)}>
                  <Plus aria-hidden="true" />
                </TooltipButton>
              </>}
            </aside>
          </aside>
        </div>
      </section>
      {active && dialog === 'new' && <RoomDialog agents={agents} engines={engines} onSave={mutate} onClose={() => setDialog(null)} />}
      {active && voiceOpen && room && <VoiceDialog key={room.id} roomId={room.id} onClose={() => setVoiceOpen(false)} />}
      {active && deleteTarget && <DeleteRoomDialog key={deleteTarget.id} name={deleteTarget.name}
        blocked={sending || snapshot.messages.some(message => message.roomId === deleteTarget.id && message.sender === 'user'
          && !!message.taskId && !isRoomWorkSettled(message.status))}
        onDelete={() => deleteRoom(deleteTarget.id)} onClose={() => setDeleteRoomId(null)} />}
    </main>
  </>;
}
