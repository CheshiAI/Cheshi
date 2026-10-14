import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { WorkspaceHostApi, WorkspaceHostState } from '../../../../shared/workspace-host';
import { LiquidGlassPanel, WorkspaceProjectIcon } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { SidebarRail } from '../navigation/SidebarRail';
import type { WorkspaceView } from '../navigation/Sidebar';
import styles from './WorkspaceHostShell.module.css';
import { useWorkspaceRailOverlay } from './useWorkspaceRailOverlay';
import { observeWorkspaceHostLayout } from './workspaceHostLayout';

export function WorkspaceHostShell({ api }: { api: WorkspaceHostApi }) {
  const [state, setState] = useState<WorkspaceHostState>({ activeId: null, entries: [] });
  const [error, setError] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const rail = useWorkspaceRailOverlay(api);
  const tabs = useRef<HTMLDivElement>(null);
  const gesture = useRef({ delta: 0, last: 0, locked: false });
  const active = state.entries.find(entry => entry.id === state.activeId);
  const run = (operation: Promise<unknown>) => { setError(null); void operation.catch(reason => setError(String(reason))); };
  useEffect(() => {
    let alive = true, changed = false;
    const unsubscribe = api.onState(next => { changed = true; setState(next); });
    void api.state().then(next => { if (alive && !changed) setState(next); }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; unsubscribe(); };
  }, [api]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    return observeWorkspaceHostLayout(element, bounds => api.layout(bounds), reason => setError(String(reason)));
  }, [api]);
  const cycle = (direction: number) => {
    if (state.entries.length < 2) return;
    const index = state.entries.findIndex(entry => entry.id === state.activeId);
    const next = state.entries[(index + direction + state.entries.length) % state.entries.length];
    if (next) run(api.activate(next.id).then(() => {
      tabs.current?.querySelector<HTMLButtonElement>(`[data-workspace-id="${next.id}"]`)?.focus();
    }));
  };
  return <div className={styles.host} ref={rail}>
    <LiquidGlassPanel as="aside" className={`${styles.rail} window-appearance-surface`} aria-label="Application navigation">
      <SidebarRail activeView={(active?.view ?? 'explorer') as WorkspaceView} sidebarOpen={active?.sidebarOpen ?? true}
        onNavigate={view => run(api.command({ action: 'navigate', view }))}
        onToggleSidebar={() => run(api.command({ action: 'sidebar' }))}
        workspaceControl={false} />
    </LiquidGlassPanel>
    <div className={styles.workspaces}>
      <div className={`${styles.header} window-appearance-surface`} onWheel={event => {
        if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
        const current = gesture.current, now = performance.now();
        if (now - current.last > 180) { current.delta = 0; current.locked = false; }
        current.last = now;
        if (current.locked) return;
        current.delta += event.deltaX;
        if (Math.abs(current.delta) >= 70) { current.locked = true; cycle(current.delta > 0 ? 1 : -1); }
      }}>
        <div ref={tabs} role="tablist" aria-label="Open workspaces" className={styles.tabs} data-single={state.entries.length === 1} onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); cycle(event.key === 'ArrowRight' ? 1 : -1); }
        }}>
          {state.entries.map(entry => <div key={entry.id} className={styles.tab} data-selected={entry.id === state.activeId}>
            <button type="button" role="tab" data-workspace-id={entry.id} aria-selected={entry.id === state.activeId} title={entry.root}
              tabIndex={entry.id === state.activeId ? 0 : -1} onClick={() => run(api.activate(entry.id))}>
              <span className={styles.projectIcon}><WorkspaceProjectIcon name={entry.name} color={entry.iconColor} /></span>
              <span className={styles.name}>{entry.name}</span>
              {entry.attention ? <span aria-label="Needs attention" className={styles.attention}>!</span>
                : entry.running > 0 && <span aria-label={`${entry.running} running`} className={styles.running} />}
            </button>
            {state.entries.length > 1 && <button type="button" className={styles.close} aria-label={`Close workspace ${entry.name}`}
              onClick={() => run(api.close(entry.id))}><X aria-hidden="true" /></button>}
          </div>)}
        </div>
        <TooltipButton variant="ghost" size="icon" className={styles.add} aria-label="Open workspace"
          title="Open workspace" disabled={!active}
          onClick={() => run(api.command({ action: 'manager' }))}><Plus aria-hidden="true" /></TooltipButton>
      </div>
      {error && <div role="alert" className={styles.error}>{error}<button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className={styles.stage} ref={stage} aria-label="Active workspace" />
    </div>
  </div>;
}
