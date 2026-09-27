import type { FormHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import { LiquidGlassPanel } from '../../shared/ui';
import styles from './ChatComposer.module.css';

/** Shared input surface; session-specific controls and queues remain with their owner. */
export function ChatComposerSurface({ queueOpen = false, children, ...form }: FormHTMLAttributes<HTMLFormElement> & { queueOpen?: boolean }) {
  return <div className={styles.composerAnchor} data-queue-open={queueOpen ? 'true' : 'false'}>
    <LiquidGlassPanel className={styles.composerSurface} data-liquid-glass-backdrop="true">
      <form {...form} className={styles.composer}>{children}</form>
    </LiquidGlassPanel>
  </div>;
}

export function ChatComposerInput(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea rows={1} {...props} />;
}

export function ChatComposerDisclaimer({ children = 'codex can make mistakes. check important answers.' }: { children?: ReactNode }) {
  return <div className={styles.disclaimerRow}><p className={styles.disclaimer}>{children}</p></div>;
}
