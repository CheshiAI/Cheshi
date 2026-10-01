import { useMemo } from 'react';
import type { MailMessage } from '../../../../shared/apple-mail';
import { NeumorphicButton } from '../../shared/ui';
import { MailHtmlBody } from './MailHtmlBody';
import { mailHtmlDocument } from './mailHtmlDocument';
import styles from './Mail.module.css';

export function MailMessageContent({ message, remoteImagesAllowed, onLoadImages, padded = false }: {
  message: MailMessage; remoteImagesAllowed: boolean; onLoadImages: () => void; padded?: boolean;
}) {
  const document = useMemo(() => message.html
    ? mailHtmlDocument(message.html, message.inlineImages ?? [], remoteImagesAllowed, window) : null,
  [message.html, message.inlineImages, remoteImagesAllowed]);
  return <>
    <div className={padded || message.html ? styles.bodyHeader : undefined}>
      <h2 className={styles.bodyTitle}>{message.subject || '(No subject)'}</h2>
      <p>{message.sender || 'Unknown sender'}</p>
      <p>To: {message.to.join(', ') || 'None'}</p>
      {message.cc.length > 0 && <p>Cc: {message.cc.join(', ')}</p>}
      <div className={styles.messageMeta}>
        <time dateTime={message.date ?? undefined}>{message.date ? new Date(message.date).toLocaleString() : 'Date unavailable'}</time>
        {document?.hasRemoteImages && !remoteImagesAllowed && <div className={styles.remoteImages}>
          <span>Remote images are hidden.</span>
          <NeumorphicButton variant="ghost" onClick={onLoadImages}>Load images</NeumorphicButton>
        </div>}
      </div>
      {message.bodyTruncated && !message.html && <p role="status">Only part of this long message is shown. Open Apple Mail to view the full content.</p>}
    </div>
    {document ? <MailHtmlBody srcDoc={document.srcDoc} remoteImagesAllowed={remoteImagesAllowed} />
      : <pre className={`${styles.bodyText} ${padded ? styles.bodyHeader : ''} ${message.body ? '' : styles.description}`}>{message.body || '(No content)'}</pre>}
  </>;
}
