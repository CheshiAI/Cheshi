import { MessagesSquare, Plus, RefreshCw, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ChatsSnapshot } from '../../../../shared/agent-chats';
import { LoadingState, NeumorphicButton, NeumorphicTextField, SidebarPanelHeader } from '../../shared/ui';
import { OverlayScrollArea } from '../../shared/ui/OverlayScrollArea';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { formatSessionElapsedTime, useChatSessionClock } from '../chat/chatSessionTime';
import sessionStyles from '../chat/ChatSessionList.module.css';
import searchStyles from '../chat/ChatHistorySearch.module.css';
import styles from './ChatsRoomList.module.css';
import type { ChatsLoadPhase } from './useChatsSnapshot';

export function ChatsRoomList({ snapshot, selectedId, phase, loaded, refreshing, disabled, error, onSelect, onNew, onRefresh }: {
  snapshot: ChatsSnapshot; selectedId: string | null; phase: ChatsLoadPhase; loaded: boolean; refreshing: boolean; disabled: boolean; error: string | null;
  onSelect(id: string): void; onNew(): void; onRefresh(): void;
}) {
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const now = useChatSessionClock(snapshot.rooms.length > 0);
  const rooms = useMemo(() => snapshot.rooms.map(room => {
    const messages = snapshot.messages.filter(message => message.roomId === room.id);
    const latest = messages.reduce<typeof messages[number] | undefined>((last, message) =>
      !last || Date.parse(message.createdAt) > Date.parse(last.createdAt) ? message : last, undefined);
    return { room, preview: latest?.text ?? 'No messages yet', updated: Date.parse(latest?.createdAt ?? room.createdAt) };
  }).sort((a, b) => b.updated - a.updated), [snapshot]);
  const visible = rooms.filter(({ room }) => room.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className={`${sessionStyles.root} ${styles.root}`} aria-label="Chats rooms">
    <SidebarPanelHeader title="CHATS" icon={<MessagesSquare aria-hidden="true" />} actions={<>
      <TooltipButton size="icon" aria-label="Refresh rooms" title="Refresh rooms" disabled={disabled || refreshing} onClick={onRefresh}><RefreshCw aria-hidden="true" /></TooltipButton>
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
      {error && <p className={styles.notice} role="alert">{error}</p>}
      <OverlayScrollArea className={sessionStyles.listScroll} label="Rooms">
        <nav className={sessionStyles.list} aria-label="Rooms" aria-busy={phase === 'loading' || refreshing}>
          {visible.map(({ room, preview, updated }) => <div key={room.id} className={sessionStyles.sessionRow}>
            <NeumorphicButton variant="ghost" className={sessionStyles.session} aria-label={room.name} aria-current={room.id === selectedId ? 'page' : undefined} onClick={() => onSelect(room.id)}>
              <span className={sessionStyles.sessionTitleRow}><TooltipTarget content={room.name}><span className={sessionStyles.sessionTitle}>{room.name}</span></TooltipTarget></span>
              <span className={sessionStyles.sessionMetadata}><span className={sessionStyles.sessionId}>{preview}</span><span className={sessionStyles.sessionTime}>{formatSessionElapsedTime(updated / 1000, now)}</span></span>
            </NeumorphicButton>
          </div>)}
          {!loaded && phase === 'loading' && <LoadingState className={sessionStyles.loading} label="Loading rooms…" />}
          {loaded && phase !== 'error' && !visible.length && <p className={`${styles.notice} ${styles.empty}`}>{query.trim() ? 'No matching rooms.' : 'Create a room and invite your agents to begin.'}</p>}
        </nav>
      </OverlayScrollArea>
    </div>
  </section>;
}
