import { useState } from 'react';
import { Reply, ReplyAll, Trash2, X } from 'lucide-react';
import { mailboxKey } from '../../../../shared/apple-mail';
import type { Mailbox, MailChange, MailMessage, MailTarget } from '../../../../shared/apple-mail';
import { Modal, NeumorphicButton, NeumorphicSurface } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import styles from './Mail.module.css';

export function MailActions({ message, target, boxes, disabled, onChange, onReply, onClose }: {
  message: MailMessage | null; target: MailTarget | null; boxes: Mailbox[]; disabled: boolean;
  onChange: (input: MailChange) => Promise<void>; onReply: (all: boolean) => void; onClose?: () => void;
}) {
  const [trashOpen, setTrashOpen] = useState(false);
  const actionsDisabled = disabled || !message || !target;
  return <>
    <div className={styles.messageToolbar} aria-label="Mail actions">
      <TooltipButton variant="ghost" size="icon" disabled={actionsDisabled} aria-label="Reply" title="Reply"
        onClick={() => onReply(false)}><Reply aria-hidden="true" /></TooltipButton>
      <TooltipButton variant="ghost" size="icon" disabled={actionsDisabled} aria-label="Reply all" title="Reply all"
        onClick={() => onReply(true)}><ReplyAll aria-hidden="true" /></TooltipButton>
      <TooltipButton variant="ghost" size="icon" disabled={actionsDisabled} aria-label="Move to Trash" title="Move to Trash"
        onClick={() => setTrashOpen(true)}><Trash2 aria-hidden="true" /></TooltipButton>
      {onClose && <TooltipButton variant="ghost" size="icon" aria-label="Close mail" title="Close mail" onClick={onClose}>
        <X aria-hidden="true" />
      </TooltipButton>}
    </div>
    {trashOpen && message && target && <MailTrashDialog boxes={boxes} target={target} subject={message.subject}
      onClose={() => setTrashOpen(false)} onMove={destination => { setTrashOpen(false); void onChange({ action: 'move', target, destination }); }} />}
  </>;
}

function MailTrashDialog({ boxes, target, subject, onClose, onMove }: {
  boxes: Mailbox[]; target: MailTarget; subject: string; onClose: () => void; onMove: (box: Mailbox) => void;
}) {
  const destinations = boxes.filter(box => mailboxKey(box) !== mailboxKey(target.mailbox)
    && box.accountId === target.mailbox.accountId);
  const [selected, setSelected] = useState(() => {
    const candidate = destinations.find(box => /^(trash|deleted messages|deleted items|휴지통)$/i.test(box.path.at(-1) ?? ''));
    return candidate ? mailboxKey(candidate) : '';
  });
  const destination = destinations.find(box => mailboxKey(box) === selected);
  return <Modal title="Move to Trash" onClose={onClose}>
    <div className={styles.form}>
      <p>{subject || '(No subject)'}</p>
      <p>Confirm the Trash mailbox for this account before moving the message.</p>
      <NeumorphicSurface raised highlightFocus className={styles.selectSurface}><select aria-label="Destination mailbox" value={selected}
        onChange={event => setSelected(event.target.value)}><option value="">Choose a mailbox</option>
        {destinations.map(box => <option key={mailboxKey(box)} value={mailboxKey(box)}>{box.accountName} / {box.path.join(' / ')}</option>)}
      </select></NeumorphicSurface>
      <div className={styles.toolbar}><NeumorphicButton size="standard" onClick={onClose}>Cancel</NeumorphicButton>
        <NeumorphicButton raised size="standard" disabled={!destination} onClick={() => destination && onMove(destination)}>Confirm move</NeumorphicButton></div>
    </div>
  </Modal>;
}
