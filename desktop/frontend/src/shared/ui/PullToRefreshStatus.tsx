import { LoadingIndicator } from './LoadingState';
import styles from './PullToRefreshStatus.module.css';

export function PullToRefreshStatus({ refreshing, pullHeight, ready }: {
  refreshing: boolean; pullHeight: number; ready: boolean;
}) {
  if (!refreshing && pullHeight <= 0) return null;
  return <div className={styles.status} role="status" style={{ height: pullHeight }}>
    <LoadingIndicator />
    <span>{refreshing || ready ? 'Release to refresh' : 'Pull to refresh'}</span>
  </div>;
}
