import { useEffect, useState, type ReactNode } from 'react';
import { cheshiDesktop } from '../../cheshiDesktop';
import { LoadingIndicator, Modal } from '../../shared/ui';
import styles from './ChatImagePreview.module.css';

function ImageDialog({ imagePath, name, onClose }: { imagePath: string; name: string; onClose(): void }) {
  const [imageUrl, setImageUrl] = useState<string | null>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!cheshiDesktop?.getCodexChatAttachmentImage) {
        if (active) setError('Restart Cheshi to view full-size images.');
        return;
      }
      try {
        const value = await cheshiDesktop.getCodexChatAttachmentImage(imagePath);
        if (active) {
          setImageUrl(value);
          if (!value) setError('This image is unavailable. It may have been moved or deleted.');
        }
      } catch {
        if (active) setError('Unable to load this image. Check that the file is still available.');
      }
    };
    void load();
    return () => { active = false; };
  }, [imagePath]);

  return <Modal title={name} headerVariant="section" closeButtonVariant="ghost" className={styles.dialog} onClose={onClose}>
    <div className={styles.content}>
      {error ? <p role="alert" className={styles.notice}>{error}</p>
        : imageUrl ? <img className={styles.image} src={imageUrl} alt={name} onError={() => setError('Unable to display this image.')} />
          : <p role="status" className={styles.notice}><LoadingIndicator />Loading image…</p>}
    </div>
  </Modal>;
}

/** A native thumbnail button shared by the composer and message history. */
export function ChatImagePreview({ imagePath, name, className, children }: {
  imagePath: string; name: string; className?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={`${styles.trigger} ${className ?? ''}`} aria-label={`View image: ${name}`}
      aria-haspopup="dialog" onClick={() => setOpen(true)}>{children}</button>
    {open && <ImageDialog key={imagePath} imagePath={imagePath} name={name} onClose={() => setOpen(false)} />}
  </>;
}
