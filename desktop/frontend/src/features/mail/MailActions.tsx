import { useState } from 'react';
import { Flag, MailOpen, Reply, ReplyAll, FolderInput, Trash2 } from 'lucide-react';
import { mailboxKey } from '../../../../shared/apple-mail';
import type { Mailbox, MailChange, MailMessage, MailTarget } from '../../../../shared/apple-mail';
import { Modal, NeumorphicButton, NeumorphicSurface } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import styles from './Mail.module.css';

export function MailActions({ message, target, boxes, disabled, onChange, onReply }: {
  message: MailMessage; target: MailTarget; boxes: Mailbox[]; disabled: boolean;
  onChange: (input: MailChange) => Promise<void>; onReply: (all: boolean) => void;
}) {
  const [move, setMove] = useState<'move' | 'trash' | null>(null);
  const readLabel = message.read ? 'Mark as unread' : 'Mark as read';
  const flagLabel = message.flagged ? 'Remove flag' : 'Flag message';
  return <>
    <div className={styles.toolbar} aria-label="Mail actions">
      <TooltipButton variant="ghost" size="icon" disabled={disabled} aria-label={readLabel} title={readLabel}
        onClick={() => void onChange({ action: 'read', target, value: !message.read })}><MailOpen aria-hidden="true" /></TooltipButton>
      <TooltipButton variant="ghost" size="icon" disabled={disabled} aria-label={flagLabel} title={flagLabel} aria-pressed={message.flagged}
        onClick={() => void onChange({ action: 'flag', target, value: !message.flagged })}><Flag aria-hidden="true" /></TooltipButton>
      <TooltipButton variant="ghost" size="icon" disabled={disabled} aria-label="Move to mailbox" title="Move to mailbox"
        onClick={() => setMove('move')}><FolderInput aria-hidden="true" /></TooltipButton>
      <TooltipButton variant="ghost" size="icon" disabled={disabled} aria-label="Move to Trash" title="Move to Trash"
        onClick={() => setMove('trash')}><Trash2 aria-hidden="true" /></TooltipButton>
      <TooltipButton variant="ghost" size="icon" disabled={disabled} aria-label="Reply" title="Reply"
        onClick={() => onReply(false)}><Reply aria-hidden="true" /></TooltipButton>
      <TooltipButton variant="ghost" size="icon" disabled={disabled} aria-label="Reply all" title="Reply all"
        onClick={() => onReply(true)}><ReplyAll aria-hidden="true" /></TooltipButton>
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
  return <Modal title={trash ? 'Move to Trash' : 'Move to mailbox'} onClose={onClose}>
    <div className={styles.form}>
      <p>{subject || '(No subject)'}</p>
      <p>{trash ? 'Confirm the Trash mailbox for this account before moving the message.' : 'Select a destination mailbox.'}</p>
      <NeumorphicSurface raised highlightFocus className={styles.selectSurface}><select aria-label="Destination mailbox" value={selected}
        onChange={event => setSelected(event.target.value)}><option value="">Choose a mailbox</option>
        {destinations.map(box => <option key={mailboxKey(box)} value={mailboxKey(box)}>{box.accountName} / {box.path.join(' / ')}</option>)}
      </select></NeumorphicSurface>
      <div className={styles.toolbar}><NeumorphicButton size="standard" onClick={onClose}>Cancel</NeumorphicButton>
        <NeumorphicButton raised size="standard" disabled={!destination} onClick={() => destination && onMove(destination)}>Confirm move</NeumorphicButton></div>
    </div>
  </Modal>;
}
