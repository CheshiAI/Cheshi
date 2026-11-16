import { SessionActivityBackground } from '../../shared/ui/SessionActivityBackground';
import { Pencil, Pin, PinOff, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { WorkerIcon } from '../../shared/ui/WorkerIcon';
import { useMemo, useRef, useState } from 'react';
import type { AgentRoom, ChatsSnapshot } from '../../../../shared/agent-chats';
import { LoadingState, NeumorphicButton, NeumorphicTextField, SidebarPanelHeader } from '../../shared/ui';
import { OverlayScrollArea } from '../../shared/ui/OverlayScrollArea';
import { PullToRefreshStatus } from '../../shared/ui/PullToRefreshStatus';
import { usePullToRefresh } from '../../shared/usePullToRefresh';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { formatSessionElapsedTime, useChatSessionClock } from '../chat/chatSessionTime';
import sessionStyles from '../chat/ChatSessionList.module.css';
import searchStyles from '../chat/ChatHistorySearch.module.css';
import styles from './ChatsRoomList.module.css';
import type { ChatsLoadPhase } from './useChatsSnapshot';
import type { SpecialistAgent } from '../../../../shared/agent-registry';
import { InlineRenameField } from '../../shared/ui/InlineRenameField';
import { RoomParticipantsPreview } from './RoomParticipantsPreview';
import { SidebarStatusMessage } from '../../shared/ui/SidebarStatusMessage';

export function ChatsRoomList({ snapshot, agents, selectedId, phase, loaded, refreshing, disabled, error, pinningRoomId, onPin, onDelete, onRename, onSelect, onNew, onRefresh, roomStatus }: {
  snapshot: ChatsSnapshot; selectedId: string | null; phase: ChatsLoadPhase; loaded: boolean; refreshing: boolean; disabled: boolean; error: string | null;
  agents: readonly SpecialistAgent[];
  onSelect(id: string): void; onNew(): void; onRefresh(): Promise<void>;
  pinningRoomId: string | null; onPin(id: string, pinned: boolean): void;
  onDelete?(id: string): void;
  onRename?(roomId: string, title: string): Promise<unknown>;
  roomStatus?(room: AgentRoom): string | null;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const refreshDisabled = disabled || refreshing || phase === 'loading';
  const refresh = usePullToRefresh(onRefresh, refreshDisabled);
  const refreshError = error || refresh.error;
  const now = useChatSessionClock(snapshot.rooms.length > 0);
  const rooms = useMemo(() => snapshot.rooms.map(room => {
    const messages = snapshot.messages.filter(message => message.roomId === room.id);
    const latest = messages.reduce<typeof messages[number] | undefined>((last, message) =>
      !last || Date.parse(message.createdAt) > Date.parse(last.createdAt) ? message : last, undefined);
    // Activity messages retain historical statuses; only task anchors describe current work.
    const working = messages.some(message => ((message.sender === 'user' && message.taskId) || message.relatedTask)
      && (message.executionStatus ?? message.status) === 'running');
    return { room, working, updated: Date.parse(latest?.createdAt ?? room.createdAt) };
  }).sort((a, b) => Number(b.room.pinned === true) - Number(a.room.pinned === true) || b.updated - a.updated), [snapshot]);
  const visible = rooms.filter(({ room }) => room.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className={`${sessionStyles.root} ${styles.root}`} aria-label="Worker rooms">
    <SidebarPanelHeader title="WORKER" icon={<WorkerIcon />} actions={<>
      <TooltipButton size="icon" aria-label="Refresh rooms" title="Refresh rooms"
        className={!disabled && loaded && (refreshing || refresh.refreshing) ? styles.refreshPending : undefined}
        disabled={refreshDisabled || refresh.refreshing} onClick={() => { void refresh.refresh(); }}><RefreshCw aria-hidden="true" /></TooltipButton>
      <TooltipButton size="icon" aria-label="New room" title="New room" disabled={disabled} onClick={onNew}><Plus aria-hidden="true" /></TooltipButton>
    </>} />
    <div className={sessionStyles.body}>
      {(rooms.length > 0 || query.length > 0) && <form className={searchStyles.searchBar} role="search" aria-label="Room search"
        onSubmit={event => { event.preventDefault(); searchInput.current?.focus(); }}>
        <TooltipTarget content="Search room names"><NeumorphicTextField ref={searchInput} className={searchStyles.searchField}
          variant="standard" type="search" aria-label="Search rooms" placeholder="Search…"
          value={query} onChange={event => setQuery(event.target.value)} onClear={() => setQuery('')} clearLabel="Clear room search" /></TooltipTarget>
        <TooltipButton raised size="icon" className={searchStyles.searchSubmit} type="submit"
          disabled={!query.trim()} aria-label="Filter rooms" title="Search room names"><Search aria-hidden="true" /></TooltipButton>
      </form>}
      {refreshError && <p className={styles.notice} role="alert">{refreshError}</p>}
      <OverlayScrollArea className={sessionStyles.listScroll} label="Rooms" viewportRef={refresh.viewportRef}>
        <PullToRefreshStatus {...refresh} />
        <nav className={sessionStyles.list} aria-label="Rooms" aria-busy={phase === 'loading' || refreshing || refresh.refreshing}>
          {visible.map(({ room, updated, working }) => <div key={room.id} className={`${sessionStyles.sessionRow} ${styles.row}`}>
            {editing?.id === room.id && onRename ? <InlineRenameField initialTitle={editing.title} inputLabel="Room title" maxLength={100}
              onSave={title => onRename(room.id, title)} onClose={() => setEditing(null)}>
              <span className={`${sessionStyles.sessionMetadata} ${styles.metadata}`}>
                <span className={sessionStyles.sessionId}>{roomStatus?.(room) ?? <RoomParticipantsPreview members={room.members} agents={agents} />}</span>
                <span className={`${sessionStyles.sessionTime} ${styles.time}`}>{formatSessionElapsedTime(updated / 1000, now)}</span>
              </span>
            </InlineRenameField> : <><NeumorphicButton variant="ghost" className={sessionStyles.session}
              data-responding={working ? 'true' : undefined}
              aria-label={room.name} aria-current={room.id === selectedId ? 'page' : undefined} onClick={() => onSelect(room.id)}>
              <SessionActivityBackground active={working} />
              {working && <span className={sessionStyles.responseStatus} role="status" aria-label="Active response" />}
              <span className={`${sessionStyles.sessionTitleRow} ${styles.title}`}><TooltipTarget content={room.name}><span className={sessionStyles.sessionTitle}>{room.name}</span></TooltipTarget>
              </span>
              <span className={`${sessionStyles.sessionMetadata} ${styles.metadata}`}>
                <span className={sessionStyles.sessionId}>{roomStatus?.(room) ?? <RoomParticipantsPreview members={room.members} agents={agents} />}</span>
                <span className={`${sessionStyles.sessionTime} ${styles.time}`}>{formatSessionElapsedTime(updated / 1000, now)}</span>
              </span>
            </NeumorphicButton>
            <div className={styles.actions}>
              <TooltipButton variant="ghost" size="icon" title="Rename room" aria-label={`Rename room: ${room.name}`}
                disabled={disabled || !onRename || editing !== null} onClick={() => setEditing({ id: room.id, title: room.name })}><Pencil aria-hidden="true" /></TooltipButton>
              <TooltipButton variant="ghost" size="icon" title="Delete room" aria-label={`Delete room: ${room.name}`}
                disabled={disabled || !onDelete} onClick={() => onDelete?.(room.id)}><Trash2 aria-hidden="true" /></TooltipButton>
              <TooltipButton variant="ghost" size="icon" title={room.pinned === true ? 'Unpin' : 'Pin'}
                aria-label={`${room.pinned === true ? 'Unpin' : 'Pin'} room: ${room.name}`} aria-pressed={room.pinned === true}
                disabled={disabled || pinningRoomId !== null} onClick={() => onPin(room.id, room.pinned !== true)}>
                {room.pinned === true ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              </TooltipButton>
            </div></>}
          </div>)}
          {!loaded && phase === 'loading' && <LoadingState className={sessionStyles.loading} label="Loading rooms…" />}
          {loaded && phase !== 'error' && !visible.length && (query.trim()
            ? <p className={`${styles.notice} ${styles.empty}`}>No matching rooms.</p>
            : <SidebarStatusMessage panel="agent-chats">create a work room and invite your homies to begin.</SidebarStatusMessage>)}
        </nav>
      </OverlayScrollArea>
    </div>
  </section>;
}
