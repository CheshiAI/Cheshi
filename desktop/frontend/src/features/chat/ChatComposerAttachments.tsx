import { TooltipButton } from '../../shared/ui/TooltipButton';
import { TooltipTarget } from '../../shared/ui/TooltipTarget';
import { FileText, X } from 'lucide-react';
import { attachmentTypeLabel } from './chatViewModel';
import type { ChatViewController } from './useChatViewController';
import styles from './ChatComposer.module.css';

export function ChatComposerAttachments({ attachments, removeAttachment }: Pick<ChatViewController, 'attachments' | 'removeAttachment'>) {
  if (attachments.length === 0) return null;
  return (
    <div className={styles.attachmentTray} aria-label="Attached files">
      {attachments.map((attachment) => {
        const showImage = attachment.kind === 'image' && Boolean(attachment.previewUrl);
        return (
          <TooltipTarget key={attachment.path} content={attachment.path}>
            <div
              className={`${styles.attachmentCard} ${showImage ? styles.imageAttachmentCard : styles.fileAttachmentCard}`}
            >
              {showImage ? (
                <img alt={attachment.name} src={attachment.previewUrl} />
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
        );
      })}
    </div>
  );
}
