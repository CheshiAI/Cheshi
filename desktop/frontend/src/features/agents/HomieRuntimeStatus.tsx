import { LiquidGlassPanel } from '../../shared/ui';
import type { RuntimeStatusPresentation } from './runtimeStatusPresentation';
import styles from './AgentsView.module.css';

export function HomieRuntimeStatus({ status }: { status: RuntimeStatusPresentation }) {
  return <LiquidGlassPanel as="section" className={styles.runtimeStatus} aria-label="Status">
    <h3>Status</h3>
    <strong role="status" aria-label="Worker status">{status.label}</strong>
    <p role={status.error ? 'alert' : undefined}>{status.reason}</p>
    <p><span className={styles.runtimeNext}>Next step</span>{status.next}</p>
  </LiquidGlassPanel>;
}
