import { useRef, useState } from 'react';
import type { ChatsRequest, RoomMessage } from '../../../../shared/agent-chats';
import { LiquidGlassPanel, NeumorphicButton } from '../../shared/ui';
import styles from './IsolatedTask.module.css';

const phaseLabels = { preparing: 'Preparing workspace', running: 'Homie working', checking: 'Checking changes',
  passed: 'Verification passed', failed: 'Task or verification failed', stale: 'Result needs fresh verification', unknown: 'Outcome needs inspection' };
export function IsolatedTaskCard({ message, mutate }: { message: RoomMessage; mutate(request: ChatsRequest): Promise<void> }) {
  const work = message.isolated!;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const active = ['preparing', 'running', 'checking'].includes(work.phase);
  async function perform(action: 'isolated-inspect' | 'isolated-cancel') {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await mutate({ action, roomId: message.roomId, messageId: message.id }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update the task.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <LiquidGlassPanel as="section" className={styles.card} aria-label="Isolated task result">
    <strong role="status">{phaseLabels[work.phase]}</strong>
    <p>Allowed changes: {work.scope.join(', ')}</p>
    <p>Check: <code>{work.check}</code></p>
    {work.phase === 'passed' && <p>The checked candidate is ready for review. Its changes remain in the isolated workspace.</p>}
    {work.error && <p role="status">{work.error}</p>}
    {work.output && <details><summary>Homie output and verification</summary><pre>{work.output}</pre></details>}
    {work.diff && <details><summary>Review changes</summary><pre aria-label="Isolated task diff">{work.diff}</pre></details>}
    {work.workspace && <details><summary>Execution record</summary>
      <dl><dt>Workspace</dt><dd>{work.workspace}</dd><dt>Branch</dt><dd>{work.branch}</dd>
        <dt>Commit</dt><dd>{work.commit ?? 'No result commit'}</dd><dt>Session</dt><dd>{work.sessionId ?? 'No recorded session'}</dd></dl>
    </details>}
    <div className={styles.actions}>
      <NeumorphicButton variant="ghost" disabled={busy} onClick={() => void perform(active ? 'isolated-cancel' : 'isolated-inspect')}>
        {active ? 'Stop isolated task' : 'Check saved result'}
      </NeumorphicButton>
    </div>
    {error && <p role="alert">{error}</p>}
  </LiquidGlassPanel>;
}
