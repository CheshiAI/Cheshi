import { Terminal } from 'lucide-react';

import { CodePanel, ContentCard } from '../../shared/ui';
import type { ChatActivityItem } from './model';
import styles from './CommandActivity.module.css';

export function CommandActivity({ item }: { item: ChatActivityItem }) {
  const running = item.status === 'inProgress';
  const status = running ? 'Running' : item.status === 'failed' ? 'Failed'
    : item.status === 'declined' ? 'Declined' : item.status === 'interrupted' ? 'Response stopped' : 'Completed';
  const emptyOutput = running ? 'Waiting for output…'
    : item.output === undefined ? 'Output is not available in this record.' : 'No output.';

  return (
    <ContentCard className={styles.card} collapsible descriptionWhenCollapsed icon={<Terminal aria-hidden="true" />} title={item.label}
      description={item.detail} status={status} data-status={item.status}>
      <CodePanel className={styles.code} variant="plain" code={item.detail} ariaLabel="Full command" copyable={false} />
      {item.output ? <div className={styles.output}>
        <CodePanel className={styles.code} variant="plain" code={item.output} ariaLabel="Command output" copyable={false} />
      </div> : <p className={styles.empty}>{emptyOutput}</p>}
      {(item.cwd || item.exitCode !== undefined || item.durationMs !== undefined) && <footer className={styles.metadata}>
        {item.cwd && <span>Directory: {item.cwd}</span>}
        {item.exitCode !== undefined && <span>Exit code: {item.exitCode}</span>}
        {item.durationMs !== undefined && <span>Duration: {(item.durationMs / 1000).toFixed(2)}s</span>}
      </footer>}
    </ContentCard>
  );
}
