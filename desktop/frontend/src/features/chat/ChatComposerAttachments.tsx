import { FileText, X } from 'lucide-react';
import { NeumorphicButton } from '../../shared/ui';
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
          <div
            className={`${styles.attachmentCard} ${showImage ? styles.imageAttachmentCard : styles.fileAttachmentCard}`}
            key={attachment.path}
            title={attachment.path}
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
            <NeumorphicButton
              variant="standard"
              size="icon"
              aria-label={`Remove ${attachment.name}`}
              className={styles.attachmentRemove}
              title={`Remove ${attachment.name}`}
              onClick={() => removeAttachment(attachment.path)}
            >
              <X aria-hidden="true" />
            </NeumorphicButton>
          </div>
        );
      })}
    </div>
  );
}
