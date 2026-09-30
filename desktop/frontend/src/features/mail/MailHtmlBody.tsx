import { useEffect, useMemo, useRef } from 'react';
import type { MailMessage } from '../../../../shared/apple-mail';
import { NeumorphicButton } from '../../shared/ui';
import { mailHtmlDocument, mailLink } from './mailHtmlDocument';
import styles from './MailHtmlBody.module.css';

export function MailHtmlBody({ message, remoteImages, onLoadImages }: {
  message: MailMessage; remoteImages: boolean; onLoadImages: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const document = useMemo(() => mailHtmlDocument(message.html ?? '', message.inlineImages ?? [], remoteImages, window),
    [message.html, message.inlineImages, remoteImages]);
  useEffect(() => () => cleanup.current?.(), []);

  const loaded = () => {
    cleanup.current?.();
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) return;
    const measure = () => {
      const height = Math.ceil(doc.body.getBoundingClientRect().height);
      frame.style.height = `${Math.max(200, Math.min(50_000, height))}px`;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(doc.body);
    const openLink = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!anchor) return;
      event.preventDefault();
      if (event.button !== 0 && event.button !== 1) return;
      const href = mailLink(anchor.getAttribute('href') ?? '');
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    };
    doc.addEventListener('click', openLink);
    doc.addEventListener('auxclick', openLink);
    measure();
    cleanup.current = () => {
      observer.disconnect();
      doc.removeEventListener('click', openLink);
      doc.removeEventListener('auxclick', openLink);
    };
  };

  return <div className={styles.root}>
    {document.hasRemoteImages && !remoteImages && <div className={styles.remoteImages}>
      <span>Remote images are hidden.</span>
      <NeumorphicButton variant="ghost" onClick={onLoadImages}>Load images</NeumorphicButton>
    </div>}
    <iframe ref={frameRef} className={styles.frame} title="HTML message content"
      sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={document.srcDoc} onLoad={loaded} />
  </div>;
}
