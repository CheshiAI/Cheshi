import { CornerDownRight, ListEnd, MessageCirclePlus, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LiquidGlassPanel, NeumorphicButton, NeumorphicSurface } from '../../shared/ui';
import { focusAdjacentMenuItem, useContextMenuInteractions } from '../../shared/ui/contextMenuInteractions';
import { useHelpLanguage } from '../../shared/useHelpLanguage';
import type { ChatViewController } from './useChatViewController';
import styles from './ChatMessageQueue.module.css';

const labels = {
  ko: { queue: '대기열', steer: '현재 작업 조정', remove: '대기 메시지 삭제', more: '대기 메시지 더보기',
    edit: '메시지 편집', side: '사이드 채팅에서 열기', enable: '대기열 켜기', disable: '대기열 끄기',
    paused: '자동 전송 일시 중지', waiting: '현재 응답이 끝나면 순서대로 전송합니다',
    sending: '전송 중', unknown: '전송 여부를 확인할 수 없습니다. 대화를 확인한 뒤 편집하거나 삭제하세요.',
    clearDraft: '입력 중인 메시지를 먼저 보내거나 비운 뒤 편집할 수 있습니다.',
    hint: 'Enter / Tab: 대기열에 추가', show: '대기열 펼치기', hide: '대기열 접기' },
  en: { queue: 'Message queue', steer: 'Steer current task', remove: 'Delete queued message', more: 'Queued message actions',
    edit: 'Edit message', side: 'Open in side chat', enable: 'Enable queue', disable: 'Disable queue',
    paused: 'Automatic sending paused', waiting: 'Messages send in order after the current response',
    sending: 'Sending', unknown: 'Delivery is unconfirmed. Check this conversation before editing or deleting.',
    clearDraft: 'Send or clear your current draft before editing this message.',
    hint: 'Enter / Tab: queue message', show: 'Show message queue', hide: 'Hide message queue' },
};
export type ChatQueueController = Pick<ChatViewController,
  'streaming' | 'loading' | 'queueBlocked' | 'interactionsLocked' | 'commandMenuOpen' | 'canOpenSideChat'
  | 'draft' | 'attachments' | 'selectedSkill' | 'sendRecovery' | 'editQueuedMessage' | 'openQueuedSideChat'> & {
    messageQueue: Pick<ChatViewController['messageQueue'], 'paused' | 'entries' | 'steer' | 'remove' | 'toggleCurrent'>;
  };
interface MenuTarget { id: string; trigger: HTMLButtonElement }
function QueueMenu({ target, controller, onClose }: {
  target: MenuTarget; controller: ChatQueueController; onClose(): void;
}) {
  const [language] = useHelpLanguage();
  const copy = labels[language];
  const ref = useRef<HTMLDivElement>(null);
  useContextMenuInteractions(ref, onClose);
  const rect = target.trigger.getBoundingClientRect();
  const canEdit = !controller.draft && !controller.selectedSkill && controller.attachments.length === 0
    && (!controller.sendRecovery || controller.sendRecovery.status === 'restored');
  const disabled = controller.queueBlocked || controller.loading || controller.messageQueue.entries
    .some((entry) => entry.id === target.id && entry.status === 'sending');
  const action = (run: () => void) => { onClose(); run(); };
  return createPortal(<div ref={ref} className="liquid-glass-context-menu-anchor" style={{
    width: 232, left: Math.max(8, Math.min(rect.right - 232, window.innerWidth - 240)),
    top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 152)),
  }}>
    <LiquidGlassPanel role="menu" aria-label={copy.more} className={`liquid-glass-context-menu ${styles.menu}`}
      onKeyDown={focusAdjacentMenuItem}>
      <button type="button" role="menuitem" className="liquid-glass-menu-item" disabled={disabled || !canEdit}
        title={!canEdit ? copy.clearDraft : undefined} onClick={() => action(() => controller.editQueuedMessage(target.id))}>
        <Pencil aria-hidden="true" /><span>{copy.edit}</span>
      </button>
      <button type="button" role="menuitem" className="liquid-glass-menu-item" disabled={disabled || !controller.canOpenSideChat}
        onClick={() => action(() => controller.openQueuedSideChat(target.id))}>
        <MessageCirclePlus aria-hidden="true" /><span>{copy.side}</span>
      </button>
      <button type="button" role="menuitem" className="liquid-glass-menu-item" disabled={controller.interactionsLocked}
        onClick={() => action(controller.messageQueue.toggleCurrent)}>
        {controller.messageQueue.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        <span>{controller.messageQueue.paused ? copy.enable : copy.disable}</span>
      </button>
    </LiquidGlassPanel>
  </div>, document.body);
}

export function ChatMessageQueue({ controller, open, panelId }: {
  controller: ChatQueueController; open: boolean; panelId: string;
}) {
  const [language] = useHelpLanguage();
  const copy = labels[language];
  const { messageQueue: queue } = controller;
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const closeMenu = useCallback(() => { target?.trigger.focus(); setTarget(null); }, [target]);
  const expanded = open && queue.entries.length > 0;
  useEffect(() => { if (!expanded) setTarget(null); }, [expanded]);
  const visibleTarget = expanded && target && queue.entries.some((entry) => entry.id === target.id) ? target : null;
  return <div id={panelId} className={styles.collapse} data-open={expanded ? 'true' : 'false'}
    aria-hidden={!expanded} inert={!expanded} onKeyDown={(event) => {
      if (event.key === 'Escape' && visibleTarget && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); closeMenu();
      }
    }}>
    <div className={styles.clip}>
      <LiquidGlassPanel as="section" aria-label={copy.queue} className={styles.queue} data-liquid-glass-backdrop="true">
        <div className={styles.status}>
          <span>{queue.paused ? copy.paused : copy.waiting}</span>
          <NeumorphicButton size="icon" raised disabled={controller.interactionsLocked} aria-pressed={!queue.paused}
            title={queue.paused ? copy.enable : copy.disable} aria-label={queue.paused ? copy.enable : copy.disable}
            onClick={queue.toggleCurrent}>{queue.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</NeumorphicButton>
        </div>
        <ol className={styles.entries}>
          {queue.entries.map((entry) => {
            const sending = entry.status === 'sending';
            const disabled = sending || controller.queueBlocked || controller.loading;
            return <li key={entry.id} className={styles.entry} aria-busy={sending}>
              <div className={styles.row}>
                <NeumorphicSurface as="span" raised data-size="icon" className={styles.entryIcon} aria-hidden="true">
                  <ListEnd />
                </NeumorphicSurface>
                <div className={styles.preview}>
                  <span title={entry.input.draft}>{entry.input.draft}</span>
                  {(entry.input.selectedSkill || entry.input.attachments.length > 0) && <small>
                    {[entry.input.selectedSkill ? `$${entry.input.selectedSkill.name}` : '', ...entry.input.attachments.map((item) => item.name)].filter(Boolean).join(' · ')}
                  </small>}
                </div>
                <NeumorphicButton className={styles.steer} disabled={disabled || !controller.streaming || entry.status === 'unknown'}
                  title={copy.steer} aria-label={copy.steer} onClick={() => { void queue.steer(entry.id); }}>
                  <CornerDownRight aria-hidden="true" /><span>{copy.steer}</span>
                </NeumorphicButton>
                <NeumorphicButton size="icon" raised disabled={sending || controller.interactionsLocked}
                  title={copy.remove} aria-label={copy.remove} onClick={() => queue.remove(entry.id)}><Trash2 aria-hidden="true" /></NeumorphicButton>
                <NeumorphicButton size="icon" raised disabled={sending || controller.interactionsLocked} aria-haspopup="menu"
                  aria-expanded={visibleTarget?.id === entry.id} title={copy.more} aria-label={copy.more}
                  onClick={(event) => setTarget({ id: entry.id, trigger: event.currentTarget })}><MoreHorizontal aria-hidden="true" /></NeumorphicButton>
              </div>
              {sending && <span className={styles.notice} role="status">{copy.sending}</span>}
              {entry.error && <span className={styles.notice} role="status">{entry.status === 'unknown' ? copy.unknown : entry.error}</span>}
            </li>;
          })}
        </ol>
        {visibleTarget && <QueueMenu key={visibleTarget.id} target={visibleTarget} controller={controller} onClose={closeMenu} />}
      </LiquidGlassPanel>
    </div>
  </div>;
}

export function ChatQueueToggle({ controller, open, panelId, onToggle }: {
  controller: ChatQueueController; open: boolean; panelId: string; onToggle(): void;
}) {
  const [language] = useHelpLanguage();
  const copy = labels[language];
  const available = controller.messageQueue.entries.length > 0;
  const expanded = available && open;
  return <div className={styles.hint}>
    {controller.streaming && !controller.commandMenuOpen && <span>{copy.hint}</span>}
    <NeumorphicButton className={styles.toggle} title={expanded ? copy.hide : copy.show}
      aria-label={copy.queue} aria-pressed={expanded} aria-expanded={expanded} aria-controls={panelId}
      disabled={!available} onClick={onToggle}>
      <ListEnd aria-hidden="true" /><span>{copy.queue}</span><span className={styles.switchTrack} aria-hidden="true" />
    </NeumorphicButton>
  </div>;
}
