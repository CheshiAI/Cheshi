import styles from './ChatAgentStatus.module.css';

const threadStatusLabels = new Map([
  ['notLoaded', 'Not loaded'],
  ['idle', 'Idle'],
  ['active', 'Active'],
  ['systemError', 'Error'],
]);

export function ChatAgentStatus({ status, current }: { status: string; current: boolean }) {
  return (
    <span className={styles.status}
      title="Thread loading and runtime state. This does not indicate whether the agent task is complete.">
      {current && <span>Current</span>}
      <span>Thread: {threadStatusLabels.get(status) ?? 'Unknown'}</span>
    </span>
  );
}
