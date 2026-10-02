import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentTerminalApi, AgentTerminalSession } from '../../../../shared/agent-terminal';
import { NeumorphicButton } from '../../shared/ui';
import styles from './DockerView.module.css';

/** Remains mounted while viewing logs; changing containers closes the old shell. */
export function ContainerTerminal({ api, engineId, agentId, active }: {
  api?: AgentTerminalApi; engineId: string; agentId: string; active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<AgentTerminalSession | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!api) { setError('Restart Cheshi to load container terminal support.'); return; }
    let disposed = false, opened: AgentTerminalSession | null = null;
    setSession(null); setError('');
    const unsubscribe = api.onChanged(next => {
      if (!disposed && next.id === opened?.id) setSession(next);
    });
    void api.open(engineId, agentId).then(next => {
      if (disposed) { void api.close(next.id).catch(() => {}); return; }
      opened = next; setSession(next);
    }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => {
      disposed = true; unsubscribe();
      if (opened) void api.close(opened.id).catch(() => {});
    };
  }, [api, engineId, agentId, attempt]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!api || !element || !session || session.ended) return;
    let frame: number | null = null, previous = '', disposed = false;
    const sync = () => {
      frame = null;
      const r = element.getBoundingClientRect();
      const overlay = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="tooltip"], dialog[open], [role="dialog"]')]
        .some(item => item.getClientRects().length > 0 && !item.closest('[hidden], [inert]'));
      const value = { id: session.id, x: r.x, y: r.y, width: r.width, height: r.height,
        visible: active && !overlay && !document.hidden && element.offsetParent !== null && !element.closest('[inert]'),
        dark: document.documentElement.dataset.theme !== 'light' };
      const serialized = JSON.stringify(value);
      if (serialized === previous) return;
      previous = serialized;
      void api.update(value).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(sync); };
    const resize = new ResizeObserver(schedule), mutation = new MutationObserver(schedule);
    resize.observe(element);
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['hidden', 'inert', 'open', 'class', 'style'] });
    mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    sync();
    return () => {
      disposed = true; resize.disconnect(); mutation.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      void api.update({ id: session.id, x: 0, y: 0, width: 0, height: 0, visible: false, dark: true }).catch(() => {});
    };
  }, [api, session, active]);

  return <div className={styles.terminalView} hidden={!active} aria-label="Container terminal">
    {error || session?.ended ? <div className={styles.empty}>
      <p role="status">{error || session?.error || 'Shell exited.'}</p>
      {api && <NeumorphicButton variant="ghost" onClick={() => setAttempt(value => value + 1)}>Reconnect</NeumorphicButton>}
    </div> : !session ? <p className={styles.empty} role="status">Connecting to container…</p> : null}
    <div ref={host} className={styles.terminalHost} aria-label="Interactive container shell" />
  </div>;
}
