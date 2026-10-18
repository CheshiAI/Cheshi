import { ChatImagePreview } from './ChatImagePreview';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { FileText, X } from 'lucide-react';
import { attachmentTypeLabel } from './chatViewModel';
import { chatImportLabel } from '../../../../shared/chat-imports';
import type { ChatViewController } from './useChatViewController';
import styles from './ChatComposer.module.css';

export function ChatComposerAttachments({ attachments, removeAttachment, insertAttachmentReference }: Pick<ChatViewController, 'attachments' | 'removeAttachment'>
  & Partial<Pick<ChatViewController, 'insertAttachmentReference'>>) {
  if (attachments.length === 0) return null;
  return (
    <div className={styles.attachmentTray} aria-label="Attached files">
      {attachments.map((attachment) => {
        const showImage = attachment.kind === 'image' && Boolean(attachment.previewUrl);
        const referenceLabel = attachment.importNumber === undefined ? '' : chatImportLabel(attachment.importNumber);
        return (
          <div className={styles.attachmentEntry} key={attachment.path}>
            <TooltipTarget content={attachment.path}>
              <div
                className={`${styles.attachmentCard} ${showImage ? styles.imageAttachmentCard : styles.fileAttachmentCard}`}
              >
                {showImage ? (
                  <ChatImagePreview imagePath={attachment.path} name={attachment.name} className={styles.attachmentImageButton}>
                    <img alt={attachment.name} src={attachment.previewUrl} />
                  </ChatImagePreview>
                ) : (
                  <div className={styles.attachmentFileContent}>
                    <FileText aria-hidden="true" />
                    <span>
                      <strong>{attachment.name}</strong>
                      <small>{attachmentTypeLabel(attachment.name)}</small>
                    </span>
                  </div>
                )}
                <TooltipButton
                  variant="standard"
                  size="icon"
                  aria-label={`Remove ${attachment.name}`}
                  className={styles.attachmentRemove}
                  title={`Remove ${attachment.name}`}
                  onClick={() => removeAttachment(attachment.path)}
                >
                  <X aria-hidden="true" />
                </TooltipButton>
              </div>
            </TooltipTarget>
            {attachment.importNumber !== undefined && (insertAttachmentReference ? (
              <TooltipButton variant="standard"
                className={styles.attachmentReference}
                title={`Insert ${referenceLabel}`} aria-label={`Insert ${referenceLabel}`}
                onClick={() => insertAttachmentReference(attachment.path)}>{attachment.importNumber}</TooltipButton>
            ) : <span className={styles.attachmentReference}>{attachment.importNumber}</span>)}
          </div>
        );
      })}
    </div>
  );
}
