import { Check, Copy, Reply } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import styles from './ChatsView.module.css';

export function ChatsMessageActions({ text, copyable, replyLabel, onReply }: {
  text: string; copyable: boolean; replyLabel: string; onReply(): void;
}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useRef<{ pending: boolean } | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    lifecycle.current = { pending: false };
    setCopied(false);
    setCopying(false);
    setError(null);
    return () => {
      lifecycle.current = null;
      clearTimeout(resetTimer.current);
    };
  }, [text, copyable]);

  async function copy() {
    const current = lifecycle.current;
    if (!copyable || !current || current.pending) return;
    current.pending = true;
    clearTimeout(resetTimer.current);
    setCopying(true);
    setCopied(false);
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      if (lifecycle.current !== current) return;
      setCopied(true);
      resetTimer.current = setTimeout(() => {
        if (lifecycle.current === current) setCopied(false);
      }, 2_000);
    } catch {
      if (lifecycle.current === current) setError('Could not copy this message. Please try again.');
    } finally {
      current.pending = false;
      if (lifecycle.current === current) setCopying(false);
    }
  }

  const copyLabel = copied ? 'Copied' : 'Copy';
  return <>
    <div className={styles.messageActions}>
      <TooltipButton variant="standard" size="icon" type="button" title="Reply" aria-label={replyLabel} onClick={onReply}>
        <Reply aria-hidden="true" />
      </TooltipButton>
      {copyable && <TooltipButton variant="standard" size="icon" type="button" title={copyLabel} aria-label={copyLabel}
        disabled={copying} onClick={() => { void copy(); }}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </TooltipButton>}
    </div>
    {error && <p role="alert" className={styles.description}>{error}</p>}
  </>;
}
