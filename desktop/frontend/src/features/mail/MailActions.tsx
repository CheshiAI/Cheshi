import { useState } from 'react';
import { Flag, MailOpen, Reply, ReplyAll, FolderInput, Trash2 } from 'lucide-react';
import { mailboxKey } from '../../../../shared/apple-mail';
import type { Mailbox, MailChange, MailMessage, MailTarget } from '../../../../shared/apple-mail';
import { Modal, NeumorphicButton, NeumorphicSurface } from '../../shared/ui';
import styles from './Mail.module.css';

export function MailActions({ message, target, boxes, disabled, onChange, onReply }: {
  message: MailMessage; target: MailTarget; boxes: Mailbox[]; disabled: boolean;
  onChange: (input: MailChange) => Promise<void>; onReply: (all: boolean) => void;
}) {
  const [move, setMove] = useState<'move' | 'trash' | null>(null);
  return <>
    <div className={styles.toolbar} aria-label="메일 작업">
      <NeumorphicButton raised size="icon" disabled={disabled} aria-label={message.read ? '안 읽음으로 표시' : '읽음으로 표시'}
        onClick={() => void onChange({ action: 'read', target, value: !message.read })}><MailOpen aria-hidden="true" /></NeumorphicButton>
      <NeumorphicButton raised size="icon" disabled={disabled} aria-label={message.flagged ? '깃발 해제' : '깃발 표시'} aria-pressed={message.flagged}
        onClick={() => void onChange({ action: 'flag', target, value: !message.flagged })}><Flag aria-hidden="true" /></NeumorphicButton>
      <NeumorphicButton raised size="icon" disabled={disabled} aria-label="메일함으로 이동" onClick={() => setMove('move')}><FolderInput aria-hidden="true" /></NeumorphicButton>
      <NeumorphicButton raised size="icon" disabled={disabled} aria-label="휴지통으로 이동" onClick={() => setMove('trash')}><Trash2 aria-hidden="true" /></NeumorphicButton>
      <NeumorphicButton raised size="icon" disabled={disabled} aria-label="답장" onClick={() => onReply(false)}><Reply aria-hidden="true" /></NeumorphicButton>
      <NeumorphicButton raised size="icon" disabled={disabled} aria-label="전체 답장" onClick={() => onReply(true)}><ReplyAll aria-hidden="true" /></NeumorphicButton>
    </div>
    {move && <MailMoveDialog boxes={boxes} target={target} trash={move === 'trash'} subject={message.subject}
      onClose={() => setMove(null)} onMove={destination => { setMove(null); void onChange({ action: 'move', target, destination }); }} />}
  </>;
}

function MailMoveDialog({ boxes, target, trash, subject, onClose, onMove }: {
  boxes: Mailbox[]; target: MailTarget; trash: boolean; subject: string; onClose: () => void; onMove: (box: Mailbox) => void;
}) {
  const destinations = boxes.filter(box => mailboxKey(box) !== mailboxKey(target.mailbox)
    && (!trash || box.accountId === target.mailbox.accountId));
  const [selected, setSelected] = useState(() => {
    const candidate = trash ? destinations.find(box => /^(trash|deleted messages|deleted items|휴지통)$/i.test(box.path.at(-1) ?? '')) : null;
    return candidate ? mailboxKey(candidate) : '';
  });
  const destination = destinations.find(box => mailboxKey(box) === selected);
  return <Modal title={trash ? '휴지통으로 이동' : '메일함으로 이동'} onClose={onClose}>
    <div className={styles.form}>
      <p>{subject || '(제목 없음)'}</p>
      <p>{trash ? '이 계정의 휴지통 메일함을 확인하고 이동해 주세요.' : '이동할 메일함을 선택해 주세요.'}</p>
      <NeumorphicSurface raised highlightFocus className={styles.selectSurface}><select aria-label="이동할 메일함" value={selected}
        onChange={event => setSelected(event.target.value)}><option value="">메일함 선택</option>
        {destinations.map(box => <option key={mailboxKey(box)} value={mailboxKey(box)}>{box.accountName} / {box.path.join(' / ')}</option>)}
      </select></NeumorphicSurface>
      <div className={styles.toolbar}><NeumorphicButton size="standard" onClick={onClose}>취소</NeumorphicButton>
        <NeumorphicButton raised size="standard" disabled={!destination} onClick={() => destination && onMove(destination)}>이동 확인</NeumorphicButton></div>
    </div>
  </Modal>;
}
