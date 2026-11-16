import { createContext, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { chatImportLabel, type NumberedChatImport } from '../../../../shared/chat-imports';
import styles from './ChatImportAttachments.module.css';

export const ChatImportContext = createContext<readonly NumberedChatImport[]>([]);

export function ChatImportAttachments({ imports, renderImage, renderFile }: {
  imports: readonly NumberedChatImport[];
  renderImage: (attachment: NumberedChatImport) => ReactNode;
  renderFile: (attachment: NumberedChatImport, children: ReactNode) => ReactNode;
}) {
  if (!imports.length) return null;
  return <div className={styles.attachments} aria-label="Attached imports">
    {imports.map(attachment => <div key={attachment.importNumber}
      className={`${styles.attachment}${attachment.kind === 'image' ? ` ${styles.imageAttachment}` : ''}`}
      data-import-number={attachment.importNumber}>
      {attachment.kind === 'image' ? <>
        {renderImage(attachment)}
        <span className={styles.imageBadge}>{attachment.importNumber}</span>
      </> : renderFile(attachment, <span className={styles.file}>
        <FileText aria-hidden="true" />
        <span><span className={styles.label}>{chatImportLabel(attachment.importNumber)}</span>
          <span className={styles.name}>{attachment.name}</span></span>
      </span>)}
    </div>)}
  </div>;
}
