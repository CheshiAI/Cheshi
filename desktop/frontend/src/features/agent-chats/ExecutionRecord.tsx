import { FileCode, Terminal, Wrench } from 'lucide-react';
import type { TaskActivity } from '../../../../shared/agent-activity';
import { LiquidGlassPanel } from '../../shared/ui';
import styles from './ChatsView.module.css';

export function ExecutionRecord({ activity }: { activity: TaskActivity }) {
  const Icon = activity.kind === 'command' ? Terminal : activity.kind === 'file' ? FileCode : Wrench;
  const label = { running: 'Running', completed: 'Completed', failed: 'Failed', unknown: 'Result unknown' }[activity.status];
  return <LiquidGlassPanel className={styles.execution}><details>
    <summary><Icon aria-hidden="true" /><span>{activity.title || activity.kind}</span><strong data-status={activity.status}>{label}</strong></summary>
    {activity.status === 'failed' && <p>Execution failed. Review the recorded output before continuing.</p>}
    <pre>{activity.text || 'No output recorded yet.'}</pre>
    {activity.truncated && <p>Output shortened to the retained excerpt.</p>}
  </details></LiquidGlassPanel>;
}
