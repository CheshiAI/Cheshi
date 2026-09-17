import { Navigation, PanelRight, Play, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AUTOPILOT_MAX_STEPS, autopilotRunning, safeAutopilotUrl } from '../../../../shared/autopilot';
import type { AutopilotState } from '../../../../shared/autopilot';
import { cheshiDesktop } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';
import { nativeBrowserViewportRequest, observeNativeBrowserViewport } from '../../shared/nativeBrowserViewport';
import { LiquidGlassPanel, NeumorphicButton, NeumorphicTextField, TieredHeader,
  draggableWindowRegionStyle, nonDraggableWindowRegionStyle } from '../../shared/ui';
import { BetaBadge } from '../../shared/ui/BetaBadge';
import styles from './AutopilotView.module.css';

interface Props {
  active: boolean;
  blocked: boolean;
  rightSidebarOpen: boolean;
  onToggleRightSidebar(): void;
}
const phaseLabels = { idle: 'Ready', loading: 'Loading page…', thinking: 'Choosing the next link…',
  completed: 'Goal reached', stopped: 'Stopped', limit: 'Step limit reached', error: 'Could not continue' } as const;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export function AutopilotView({ active, blocked, rightSidebarOpen, onToggleRightSidebar }: Props) {
  const api = cheshiDesktop?.autopilot;
  const [url, setUrl] = useState('https://en.wikipedia.org/wiki/DNA');
  const [goal, setGoal] = useState('Reach the Wikipedia page for Manipuri pony.');
  const [state, setState] = useState<AutopilotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const commandPending = useRef(false);
  const mounted = useRef(true);
  const revision = useRef(0);
  const running = state ? autopilotRunning(state) : false;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!api || !active) return;
    let disposed = false;
    const unsubscribe = api.onState(value => {
      revision.current += 1;
      if (!disposed) setState(value);
    });
    const id = revision.current;
    void api.getState().then(value => {
      if (!disposed && id === revision.current) { setState(value); setError(null); }
    }).catch(cause => { if (!disposed) setError(errorMessage(cause, 'Could not connect to Autopilot.')); });
    return () => { disposed = true; unsubscribe(); };
  }, [api, active]);

  useLayoutEffect(() => {
    if (!api || !active || blocked || !viewport.current) return;
    setViewportError(null);
    return observeNativeBrowserViewport(viewport.current, nativeBrowserViewportRequest,
      request => api.setView(request), cause => setViewportError(errorMessage(cause, 'Could not display the browser.')));
  }, [api, active, blocked]);

  const execute = async (action: 'start' | 'stop') => {
    if (!api || commandPending.current) return;
    commandPending.current = true;
    setPending(true);
    setError(null);
    const id = revision.current;
    try {
      const value = action === 'start' ? await api.start({ url, goal }) : await api.stop();
      if (mounted.current && id === revision.current) setState(value);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause, 'Could not update Autopilot.'));
    } finally {
      commandPending.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const currentError = error ?? viewportError ?? state?.error;
  const steps = state?.steps ?? [];
  return (
    <main className={styles.root} hidden={!active} inert={!active || blocked} aria-hidden={!active} aria-label="Autopilot">
      <TieredHeader className={styles.header} style={draggableWindowRegionStyle}
        primary={<>
          <div className={styles.title}><Navigation aria-hidden="true" /><h1>Autopilot</h1><BetaBadge /></div>
          <NeumorphicButton raised size="icon" style={nonDraggableWindowRegionStyle}
            aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
            aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></NeumorphicButton>
        </>}
        secondary={<span className={styles.description}>Follow links to your destination. Up to {AUTOPILOT_MAX_STEPS} steps per run.</span>} />
      <form className={styles.controls} onSubmit={event => { event.preventDefault(); if (!running) void execute('start'); }}>
        <label>Start URL<NeumorphicTextField aria-label="Start URL" value={url} type="url" required
          maxLength={8192} disabled={running || pending} onChange={event => setUrl(event.target.value)} /></label>
        <label className={styles.goal}>Goal<NeumorphicTextField aria-label="Goal" value={goal} required
          maxLength={2000} disabled={running || pending} placeholder="Where would you like to go?"
          onChange={event => setGoal(event.target.value)} /></label>
        {running ? <NeumorphicButton size="standard" disabled={pending} onClick={() => void execute('stop')}>
          <Square aria-hidden="true" />Stop</NeumorphicButton>
          : <NeumorphicButton size="standard" type="submit"
            disabled={pending || !api || !state?.configured || !safeAutopilotUrl(url) || !goal.trim()}>
            <Play aria-hidden="true" />Start</NeumorphicButton>}
      </form>
      {!api && <p className={styles.notice}>Autopilot is available in the Cheshi desktop app.</p>}
      {api && state && !state.configured && <p className={styles.notice}>Add TYPE_SAFE_AI to the app environment to enable Autopilot.</p>}
      {currentError && <p className={styles.notice} role="alert">{currentError}</p>}
      <div className={styles.status} role="status">
        <span>{state ? phaseLabels[state.phase] : api ? 'Connecting…' : 'Not connected'}</span>
        <span>{Math.max(0, steps.length - 1)} / {AUTOPILOT_MAX_STEPS} steps</span>
        <span>Model {seconds(state?.modelMs ?? 0)}</span>
        <span>Pages {seconds(steps.reduce((sum, step) => sum + step.loadMs, 0))}</span>
      </div>
      <div className={styles.content}>
        <div className={styles.browser}>
          <div className={styles.address} title={state?.url}>{state?.url || 'Your browser session will appear here.'}</div>
          <div className={styles.viewport} ref={viewport} aria-label="Autopilot browser">
            {!state?.url && <div className={styles.empty}><Navigation aria-hidden="true" />
              <p>Choose a starting page and tell Autopilot where to go.</p>
              <p>Page text and link choices are sent to TypeSafe while a run is active.</p>
            </div>}
          </div>
        </div>
        <LiquidGlassPanel as="aside" className={styles.history} aria-label="Navigation history">
          <h2>Journey</h2>
          {!steps.length && <p>Pages visited will appear here.</p>}
          <ol>{steps.map((step, index) => <li key={`${index}:${step.url}`}>
            <span className={styles.stepNumber}>{index === 0 ? 'Start' : index}</span>
            <div><strong>{step.title || step.url}</strong><span className={styles.stepUrl} title={step.url}>{step.url}</span>
              <small>Page {seconds(step.loadMs)}{index > 0 && ` · Model ${seconds(step.decisionMs)}`}</small>
            </div>
          </li>)}</ol>
        </LiquidGlassPanel>
      </div>
    </main>
  );
}
