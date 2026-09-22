import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, Folder, Mail, PanelRight, RefreshCw, SquarePen, Flag } from 'lucide-react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { SidebarToggle, LiquidGlassPanel, NeumorphicButton, TwoTierHeader, draggableWindowRegionStyle, nonDraggableWindowRegionStyle } from '../../shared/ui';
import { mailboxKey } from '../../../../shared/apple-mail';
import type { AppleMailApi, Mailbox } from '../../../../shared/apple-mail';
import { MailModel } from './mailModel';
import { mailComposer } from './mailComposer';
import { MailComposerDialog } from './MailComposerDialog';
import { MailActions } from './MailActions';
import styles from './Mail.module.css';

interface MailViewProps { rightSidebarOpen: boolean; onToggleRightSidebar: () => void }
function received(date: string | null) { return date ? new Date(date).toLocaleString() : '날짜 없음'; }

export function MailView(props: MailViewProps) {
  const api = cheshiDesktop?.appleMail;
  return api?.available ? <MailBrowser api={api} {...props} />
    : <main className={styles.workspace}><p className={styles.notice}>Apple Mail 연동은 macOS용 Cheshi에서 사용할 수 있습니다.</p></main>;
}

export function MailBrowser({ api, rightSidebarOpen, onToggleRightSidebar }: MailViewProps & { api: AppleMailApi }) {
  const model = useMemo(() => new MailModel(api), [api]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const composer = useMemo(() => mailComposer(api), [api]);
  const composition = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  useEffect(() => () => model.cancelPending(), [model]);
  const groups = new Map<string | null, Mailbox[]>();
  for (const box of state.boxes) {
    const group = groups.get(box.accountId) ?? [];
    group.push(box);
    groups.set(box.accountId, group);
  }
  const busy = state.loadingBoxes || state.loadingPage || state.changing;
  return <main className={styles.workspace} aria-label="Mail">
    <TwoTierHeader className={styles.header} style={draggableWindowRegionStyle} primary={<>
      <div className={styles.heading}><Mail aria-hidden="true" /><h1>Mail</h1></div>
      <div className={styles.actions} style={nonDraggableWindowRegionStyle}>
        <NeumorphicButton raised size="icon" aria-label={composition.form ? '작성 중인 메일' : '새 메일 작성'} disabled={!state.connected}
          onClick={() => void composer.start()}><SquarePen aria-hidden="true" /></NeumorphicButton>
        <NeumorphicButton raised size="icon" aria-label="메일 새로고침" disabled={!state.connected || busy}
          onClick={() => void model.connect()}><RefreshCw aria-hidden="true" /></NeumorphicButton>
        <SidebarToggle raised size="icon" aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
          aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></SidebarToggle>
      </div>
    </>} />
    {composition.notice && <p className={styles.notice} role="status">{composition.notice}</p>}
    {state.changeError && <p className={styles.notice} role="alert">{state.changeError}</p>}
    {!state.connected ? <div className={styles.connect}>
      <Mail aria-hidden="true" />
      <p>Apple Mail의 메일함과 메일 본문을 확인할 수 있습니다.</p>
      {state.boxesError && <p role="alert">{state.boxesError}</p>}
      <NeumorphicButton raised size="standard" disabled={state.loadingBoxes} onClick={() => void model.connect()}>
        {state.loadingBoxes ? '연결 확인 중…' : 'Apple Mail 연결'}
      </NeumorphicButton>
    </div> : <div className={styles.browser}>
      <LiquidGlassPanel as="aside" className={styles.mailboxes} aria-label="메일함">
        {state.loadingBoxes ? <p role="status">메일함을 불러오는 중…</p>
          : state.boxes.length === 0 ? <p role="status">메일함이 없습니다. Apple Mail에 계정을 추가한 뒤 새로고침해 주세요.</p>
          : [...groups].map(([accountId, boxes]) => <section key={accountId ?? 'local'}>
            <h2>{boxes[0]?.accountName || '계정'}</h2>
            {boxes.map(box => <button type="button" key={mailboxKey(box)} className={styles.mailbox}
              aria-pressed={state.selectedBox !== null && mailboxKey(box) === mailboxKey(state.selectedBox)}
              disabled={state.loadingBoxes || state.changing} onClick={() => void model.selectMailbox(box)}>
              <Folder aria-hidden="true" /><span>{box.path.join(' / ')}</span>
              {box.unread > 0 && <span className={styles.count} aria-label={`읽지 않음 ${box.unread}개`}>{box.unread}</span>}
            </button>)}
          </section>)}
      </LiquidGlassPanel>
      <LiquidGlassPanel as="section" className={styles.messages} aria-label="메일 목록" aria-busy={busy}>
        <h2 className={styles.listTitle}>{state.selectedBox?.path.at(-1) ?? '메일'}</h2>
        <div className={styles.messageList}>
          {busy ? <p className={styles.notice} role="status">메일을 불러오는 중…</p>
            : state.pageError ? <div className={styles.notice}><p role="alert">{state.pageError}</p>
              <NeumorphicButton size="standard" onClick={() => state.selectedBox && void model.selectMailbox(state.selectedBox)}>다시 시도</NeumorphicButton></div>
            : state.page?.messages.length === 0 ? <p className={styles.notice} role="status">메일이 없습니다.</p>
            : state.page?.messages.map(message => <button key={message.id} type="button" className={styles.messageRow}
              disabled={state.changing} aria-pressed={state.selectedId === message.id} onClick={() => void model.selectMessage(message.id)}>
              <span className={styles.sender}>{!message.read && <span className={styles.unread} aria-label="읽지 않음">●</span>}{message.sender || '발신자 없음'}</span>
              {message.flagged && <Flag className={styles.flag} aria-label="깃발 있음" />}
              <span className={styles.subject}>{message.subject || '(제목 없음)'}</span>
              <time dateTime={message.date ?? undefined}>{received(message.date)}</time>
            </button>)}
        </div>
        <div className={styles.pagination}>
          <NeumorphicButton size="icon" aria-label="이전 메일 페이지" disabled={busy || !state.page || state.page.offset === 0}
            onClick={() => void model.previousPage()}><ChevronLeft aria-hidden="true" /></NeumorphicButton>
          <span>{state.page && state.page.messages.length > 0 ? `${state.page.offset + 1}–${state.page.offset + state.page.messages.length}` : ''}</span>
          <NeumorphicButton size="icon" aria-label="다음 메일 페이지" disabled={busy || state.page?.nextOffset == null}
            onClick={() => void model.nextPage()}><ChevronRight aria-hidden="true" /></NeumorphicButton>
        </div>
      </LiquidGlassPanel>
      <LiquidGlassPanel as="article" className={styles.body} aria-label="메일 본문" aria-busy={state.loadingBody}>
        {state.loadingBody ? <p role="status">본문을 불러오는 중…</p>
          : state.bodyError ? <><p role="alert">{state.bodyError}</p><NeumorphicButton size="standard"
            onClick={() => state.selectedId !== null && void model.selectMessage(state.selectedId)}>본문 다시 시도</NeumorphicButton></>
          : state.message ? <>
            {state.selectedBox && <MailActions key={`${mailboxKey(state.selectedBox)}:${state.message.id}`} message={state.message}
              target={{ mailbox: state.selectedBox, id: state.message.id }} boxes={state.boxes} disabled={busy || state.changeBlocked}
              onChange={input => model.change(input)} onReply={all => void composer.start(state.message!,
                { mailbox: state.selectedBox!, id: state.message!.id }, all)} />}
            <h2 className={styles.bodyTitle}>{state.message.subject || '(제목 없음)'}</h2>
            <p>{state.message.sender || '발신자 없음'}</p>
            <p>받는 사람: {state.message.to.join(', ') || '없음'}</p>
            {state.message.cc.length > 0 && <p>참조: {state.message.cc.join(', ')}</p>}
            <time dateTime={state.message.date ?? undefined}>{received(state.message.date)}</time>
            {state.message.bodyTruncated && <p role="status">본문이 길어 일부만 표시합니다. 전체 내용은 Apple Mail에서 확인해 주세요.</p>}
            <pre className={styles.bodyText}>{state.message.body || '(본문 없음)'}</pre>
          </> : <p role="status">메일을 선택하면 본문이 표시됩니다.</p>}
      </LiquidGlassPanel>
    </div>}
    <MailComposerDialog composer={composer} />
  </main>;
}
