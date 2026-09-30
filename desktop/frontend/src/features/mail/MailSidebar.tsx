import { Folder, Mail, RefreshCw, SquarePen } from 'lucide-react';
import type { ReactNode } from 'react';
import { mailboxKey, type Mailbox } from '../../../../shared/apple-mail';
import { LiquidGlassPanel, LoadingState, NeumorphicButton, SidebarPanelHeader } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import type { MailState } from './mailModel';
import styles from './Mail.module.css';

export function MailSidebar({ state, composing, onRefresh, onCompose, onSelect }: {
  state: MailState;
  composing: boolean;
  onRefresh(): void;
  onCompose(): void;
  onSelect(box: Mailbox): void;
}) {
  const scrollRef = useAutoHideScrollbars<HTMLDivElement>();
  const groups = new Map<string | null, Mailbox[]>();
  for (const box of state.boxes) {
    const group = groups.get(box.accountId) ?? [];
    group.push(box);
    groups.set(box.accountId, group);
  }
  const busy = state.loadingBoxes || state.loadingPage || state.changing;
  let content: ReactNode;
  if (!state.connected) {
    content = <>
      {state.boxesError && <p role="alert">{state.boxesError}</p>}
      {!state.loadingBoxes && <NeumorphicButton onClick={onRefresh}>Connect Apple Mail</NeumorphicButton>}
    </>;
  } else if (state.boxes.length === 0) {
    content = <p role="status">No mailboxes. Add an account in Apple Mail, then refresh.</p>;
  } else {
    content = [...groups].map(([accountId, boxes]) => <section key={accountId ?? 'local'}>
      <h2>{boxes[0]?.accountName || 'Account'}</h2>
      {boxes.map(box => <button type="button" key={mailboxKey(box)} className={styles.mailbox}
        aria-current={state.selectedBox && mailboxKey(box) === mailboxKey(state.selectedBox) ? 'page' : undefined}
        disabled={state.loadingBoxes || state.changing} onClick={() => onSelect(box)}>
        <Folder aria-hidden="true" /><span>{box.path.join(' / ')}</span>
        {box.unread > 0 && <span className={styles.count} aria-label={`읽지 않음 ${box.unread}개`}>{box.unread}</span>}
      </button>)}
    </section>);
  }
  return <LiquidGlassPanel as="aside" className={styles.mailSidebar} aria-label="메일함">
    <SidebarPanelHeader title="MAIL" icon={<Mail aria-hidden="true" />} actions={<>
      <TooltipButton size="icon" aria-label="메일 새로고침" title="Refresh mail" disabled={busy}
        onClick={onRefresh}><RefreshCw aria-hidden="true" /></TooltipButton>
      <TooltipButton size="icon" aria-label={composing ? '작성 중인 메일' : '새 메일 작성'}
        title={composing ? 'Resume draft' : 'Compose mail'} disabled={!state.connected}
        onClick={onCompose}><SquarePen aria-hidden="true" /></TooltipButton>
    </>} />
    <div ref={scrollRef} className={styles.mailboxes} aria-busy={state.loadingBoxes}>
      {state.loadingBoxes && <LoadingState className={styles.mailboxLoading} label="Loading mailboxes…" />}
      {content}
    </div>
  </LiquidGlassPanel>;
}
