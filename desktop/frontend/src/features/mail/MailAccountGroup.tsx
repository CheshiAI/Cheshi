import { ChevronRight, Folder } from 'lucide-react';
import { useId } from 'react';
import { mailboxKey, type Mailbox } from '../../../../shared/apple-mail';
import { AccordionContents } from '../../shared/ui/AccordionContents';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import styles from './Mail.module.css';

export function MailAccountGroup({ boxes, selectedBox, expanded, loading, changing, onToggle, onSelect }: {
  boxes: Mailbox[];
  selectedBox: Mailbox | null;
  expanded: boolean;
  loading: boolean;
  changing: boolean;
  onToggle(): void;
  onSelect(box: Mailbox): void;
}) {
  const contentId = useId();
  const accountName = boxes[0]?.accountName || 'Account';
  return <section className={styles.accountGroup}>
    <h2 className={styles.accountHeading}>
      <TooltipTarget content={accountName}>
        <button type="button" className={styles.accountToggle} aria-expanded={expanded}
          aria-controls={expanded ? contentId : undefined} onClick={onToggle}>
          <span>{accountName}</span>
          <span className={styles.accountChevronSlot} aria-hidden="true"><ChevronRight className={styles.accountChevron} /></span>
        </button>
      </TooltipTarget>
    </h2>
    <AccordionContents expanded={expanded}>
      {expanded && <div id={contentId} role="region" aria-label={`${accountName} mailboxes`}>
        {boxes.map(box => <button type="button" key={mailboxKey(box)} className={styles.mailbox}
          aria-current={selectedBox && mailboxKey(box) === mailboxKey(selectedBox) ? 'page' : undefined}
          disabled={changing} aria-disabled={loading || undefined}
          onClick={() => { if (!loading) onSelect(box); }}>
          <Folder aria-hidden="true" /><span>{box.path.join(' / ')}</span>
          {box.unread > 0 && <span className={styles.count} aria-label={`${box.unread} unread messages`}>{box.unread}</span>}
        </button>)}
      </div>}
    </AccordionContents>
  </section>;
}
