import type { ReactNode } from 'react';
import { CodePanel } from './CodePanel';
import { ContentCard } from './ContentCard';
import styles from './ExecutionCard.module.css';

interface ExecutionCardProps {
  className?: string;
  icon: ReactNode;
  title: string;
  detail: string;
  status?: string;
  state?: string;
  output?: string;
  emptyOutput?: string;
  detailLabel?: string;
  outputLabel?: string;
  notice?: string;
  truncated?: boolean;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
}

/** One disclosure and code presentation for session commands and homie execution records. */
export function ExecutionCard({ className, icon, title, detail, status, state, output, emptyOutput = 'No output recorded yet.',
  detailLabel = 'Full command', outputLabel = 'Command output', notice, truncated, cwd, exitCode, durationMs }: ExecutionCardProps) {
  return <ContentCard className={`${styles.card} ${className ?? ''}`} collapsible descriptionWhenCollapsed icon={icon} title={title}
    description={detail} status={status} data-status={state}>
    <CodePanel className={styles.code} variant="plain" code={detail} ariaLabel={detailLabel} copyable={false} />
    {notice && <p className={styles.empty}>{notice}</p>}
    {output ? <div className={styles.output}>
      <CodePanel className={styles.code} variant="plain" code={output} ariaLabel={outputLabel} copyable={false} />
    </div> : <p className={styles.empty}>{emptyOutput}</p>}
    {truncated && <p className={styles.empty}>Output shortened to the retained excerpt.</p>}
    {(cwd || exitCode !== undefined || durationMs !== undefined) && <footer className={styles.metadata}>
      {cwd && <span>Directory: {cwd}</span>}
      {exitCode !== undefined && <span>Exit code: {exitCode}</span>}
      {durationMs !== undefined && <span>Duration: {(durationMs / 1000).toFixed(2)}s</span>}
    </footer>}
  </ContentCard>;
}
