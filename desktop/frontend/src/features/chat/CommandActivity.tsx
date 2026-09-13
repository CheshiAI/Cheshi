import { ChevronRight, Terminal } from 'lucide-react';

import { LiquidGlassPanel } from '../../shared/ui';
import type { ChatActivityItem } from './model';
import styles from './CommandActivity.module.css';

export function CommandActivity({ item }: { item: ChatActivityItem }) {
  const running = item.status === 'inProgress';
  const status = running ? 'Running' : item.status === 'failed' ? 'Failed'
    : item.status === 'declined' ? 'Declined' : item.status === 'interrupted' ? 'Response stopped' : 'Completed';
  const emptyOutput = running ? 'Waiting for output…'
    : item.output === undefined ? 'Output is not available in this record.' : 'No output.';

  return (
    <LiquidGlassPanel className={styles.card} data-status={item.status} data-liquid-glass-backdrop="true">
      <details>
        <summary className={styles.summary}>
          <Terminal aria-hidden="true" />
          <span className={styles.heading}>
            <strong>{item.label}</strong>
            <span className={styles.preview}>{item.detail}</span>
          </span>
          <span className={styles.status}>{status}</span>
          <ChevronRight aria-hidden="true" className={styles.chevron} />
        </summary>
        <div className={styles.content}>
          <div className={styles.metadata}>
            {item.cwd && <span>Directory: {item.cwd}</span>}
            {item.exitCode !== undefined && <span>Exit code: {item.exitCode}</span>}
            {item.durationMs !== undefined && <span>Duration: {(item.durationMs / 1000).toFixed(2)}s</span>}
          </div>
          <strong className={styles.label}>Command</strong>
          <pre tabIndex={0} aria-label="Full command"><code>{item.detail}</code></pre>
          <strong className={styles.label}>Output</strong>
          {item.output ? <pre tabIndex={0} aria-label="Command output"><code>{item.output}</code></pre>
            : <p className={styles.empty}>{emptyOutput}</p>}
        </div>
      </details>
    </LiquidGlassPanel>
  );
}
