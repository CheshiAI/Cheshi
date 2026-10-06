import { Pin, PinOff, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { WorkerIcon } from '../../shared/ui/WorkerIcon';
import { useMemo, useRef, useState } from 'react';
import type { ChatsSnapshot } from '../../../../shared/agent-chats';
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

export function ChatsRoomList({ snapshot, selectedId, phase, loaded, refreshing, disabled, error, pinningRoomId, onPin, onDelete, onSelect, onNew, onRefresh }: {
  snapshot: ChatsSnapshot; selectedId: string | null; phase: ChatsLoadPhase; loaded: boolean; refreshing: boolean; disabled: boolean; error: string | null;
  onSelect(id: string): void; onNew(): void; onRefresh(): Promise<void>;
  pinningRoomId: string | null; onPin(id: string, pinned: boolean): void;
  onDelete?(id: string): void;
}) {
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const refreshDisabled = disabled || refreshing || phase === 'loading';
  const refresh = usePullToRefresh(onRefresh, refreshDisabled);
  const refreshError = error || refresh.error;
  const now = useChatSessionClock(snapshot.rooms.length > 0);
  const rooms = useMemo(() => snapshot.rooms.map(room => {
    const messages = snapshot.messages.filter(message => message.roomId === room.id);
    const latest = messages.reduce<typeof messages[number] | undefined>((last, message) =>
      !last || Date.parse(message.createdAt) > Date.parse(last.createdAt) ? message : last, undefined);
    return { room, preview: latest?.text ?? 'No messages yet', updated: Date.parse(latest?.createdAt ?? room.createdAt) };
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
      <form className={searchStyles.searchBar} role="search" aria-label="Room search"
        onSubmit={event => { event.preventDefault(); searchInput.current?.focus(); }}>
        <TooltipTarget content="Search room names"><NeumorphicTextField ref={searchInput} className={searchStyles.searchField}
          variant="standard" type="search" aria-label="Search rooms" placeholder="Search…"
          value={query} onChange={event => setQuery(event.target.value)} onClear={() => setQuery('')} clearLabel="Clear room search" /></TooltipTarget>
        <TooltipButton raised size="icon" className={searchStyles.searchSubmit} type="submit"
          disabled={!query.trim()} aria-label="Filter rooms" title="Search room names"><Search aria-hidden="true" /></TooltipButton>
      </form>
      {refreshError && <p className={styles.notice} role="alert">{refreshError}</p>}
      <OverlayScrollArea className={sessionStyles.listScroll} label="Rooms" viewportRef={refresh.viewportRef}>
        <PullToRefreshStatus {...refresh} />
        <nav className={sessionStyles.list} aria-label="Rooms" aria-busy={phase === 'loading' || refreshing || refresh.refreshing}>
          {visible.map(({ room, preview, updated }) => <div key={room.id} className={`${sessionStyles.sessionRow} ${styles.row}`}>
            <NeumorphicButton variant="ghost" className={sessionStyles.session} aria-label={room.name} aria-current={room.id === selectedId ? 'page' : undefined} onClick={() => onSelect(room.id)}>
              <span className={`${sessionStyles.sessionTitleRow} ${styles.title}`}><TooltipTarget content={room.name}><span className={sessionStyles.sessionTitle}>{room.name}</span></TooltipTarget>
              </span>
              <span className={`${sessionStyles.sessionMetadata} ${styles.metadata}`}><span className={sessionStyles.sessionId}>{preview}</span><span className={`${sessionStyles.sessionTime} ${styles.time}`}>{formatSessionElapsedTime(updated / 1000, now)}</span></span>
            </NeumorphicButton>
            <div className={styles.actions}>
              <TooltipButton variant="ghost" size="icon" title="Delete room" aria-label={`Delete room: ${room.name}`}
                disabled={disabled || !onDelete} onClick={() => onDelete?.(room.id)}><Trash2 aria-hidden="true" /></TooltipButton>
              <TooltipButton variant="ghost" size="icon" title={room.pinned === true ? 'Unpin' : 'Pin'}
                aria-label={`${room.pinned === true ? 'Unpin' : 'Pin'} room: ${room.name}`} aria-pressed={room.pinned === true}
                disabled={disabled || pinningRoomId !== null} onClick={() => onPin(room.id, room.pinned !== true)}>
                {room.pinned === true ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              </TooltipButton>
            </div>
          </div>)}
          {!loaded && phase === 'loading' && <LoadingState className={sessionStyles.loading} label="Loading rooms…" />}
          {loaded && phase !== 'error' && !visible.length && <p className={`${styles.notice} ${styles.empty}`}>{query.trim() ? 'No matching rooms.' : 'Create a work room and invite your Homies to begin.'}</p>}
        </nav>
      </OverlayScrollArea>
    </div>
  </section>;
}
