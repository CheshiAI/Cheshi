import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { ContentCard, useContentCardNesting } from './ContentCard';
import { NeumorphicButton } from './NeumorphicButton';
import styles from './CodePanel.module.css';

interface CodePanelProps {
  code: string;
  language?: string;
  label?: string;
  ariaLabel?: string;
  copyable?: boolean;
  variant?: 'panel' | 'plain';
  className?: string;
}

export function CodePanel({ code, language, label, ariaLabel, copyable = true, variant, className }: CodePanelProps) {
  const nested = useContentCardNesting();
  const plain = (variant ?? (nested ? 'plain' : 'panel')) === 'plain';
  const codeId = useId();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setCopied(false);
    setCopyError(false);
    return () => clearTimeout(resetTimer.current);
  }, [code]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyError(false);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopyError(true);
    }
  };

  const copyButton = copyable && <NeumorphicButton variant={plain ? 'standard' : 'ghost'} size="standard" className={styles.copyButton} aria-controls={codeId}
    aria-label={plain ? (copied ? '코드 복사 완료' : '코드 복사') : undefined} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    {plain ? (copied ? '복사됨' : `코드${language ? ` · ${language}` : ''}`) : (copied ? 'Copied' : 'Copy')}
  </NeumorphicButton>;
  const content = <>
    <pre id={codeId} className={styles.code} tabIndex={0} aria-label={ariaLabel || label || `${language || 'Plain text'} code`}><code>{code}</code></pre>
    {copyError && <p className={styles.error} role="status">Could not copy. Try again.</p>}
  </>;

  if (plain) return <div className={`${styles.plain} ${className ?? ''}`} data-copyable={copyable ? 'true' : undefined}>
    {copyButton && <header className={styles.plainHeader}>
      {copyButton}
    </header>}
    {content}
  </div>;

  return <ContentCard as="section" className={`${styles.panel} ${className ?? ''}`}
    bodyClassName={styles.body} title={<span className={styles.label}>{label || language || 'code'}</span>}
    actions={copyButton}>
    {content}
  </ContentCard>;
}
