import { Link, Navigation, PanelRight, Play, Search, Square, Target } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AUTOPILOT_MAX_STEPS, AUTOPILOT_MAX_READS, autopilotUsage, autopilotRunning, safeAutopilotUrl } from '../../../../shared/autopilot';
import type { AutopilotReportFormat, AutopilotState } from '../../../../shared/autopilot';
import { cheshiDesktop } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';
import { nativeBrowserViewportRequest, observeNativeBrowserViewport } from '../../shared/nativeBrowserViewport';
import { EmptyState, LiquidGlassPanel, NeumorphicButton, NeumorphicTextField, SearchClearButton, TieredHeader,
  draggableWindowRegionStyle, nonDraggableWindowRegionStyle } from '../../shared/ui';
import { BetaBadge } from '../../shared/ui/BetaBadge';
import styles from './AutopilotView.module.css';
import { AutopilotResearchResults } from './AutopilotResearchResults';

interface Props {
  chatContextId?: string;
  active: boolean;
  blocked: boolean;
  rightSidebarOpen: boolean;
  onToggleRightSidebar(): void;
}
const phaseLabels = { idle: 'Ready', planning: 'Planning research…', synthesizing: 'Writing and checking the report…', reading: 'Reading a document section…', loading: 'Loading page…', thinking: 'Choosing the next action…', acting: 'Acting and checking the result…',
  completed: 'Goal reached', partial: 'Partial results', stopped: 'Stopped', limit: 'Step limit reached', error: 'Could not continue' } as const;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export function AutopilotView({ active, blocked, rightSidebarOpen, onToggleRightSidebar, chatContextId }: Props) {
  const api = cheshiDesktop?.autopilot;
  const [url, setUrl] = useState('');
  const [goal, setGoal] = useState('');
  const [searchText, setSearchText] = useState('');
  const [research, setResearch] = useState(false);
  const [targetSources, setTargetSources] = useState('10');
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [state, setState] = useState<AutopilotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const goalInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
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
      if (action === 'start') setExportNotice(null);
      const value = action === 'start' ? await api.start({ url, goal, ...(searchText.trim() ? { searchText: searchText.trim() } : {}),
        ...(research ? { mode: 'research', targetSources: Number(targetSources), ...(chatContextId ? { contextId: chatContextId } : {}) } : {}) }) : await api.stop();
      if (mounted.current && id === revision.current) setState(value);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause, 'Could not update Autopilot.'));
    } finally {
      commandPending.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const exportReport = async (format: AutopilotReportFormat) => {
    if (!api || exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const saved = await api.exportReport(format);
      if (mounted.current) setExportNotice(saved ? 'Saved to Downloads/Cheshi Research.' : 'Could not save the research report.');
    } catch (cause) {
      if (mounted.current) setExportNotice(errorMessage(cause, 'Could not save the research report.'));
    } finally { if (mounted.current) setExporting(false); }
  };

  const currentError = error ?? viewportError ?? state?.error;
  const steps = state?.steps ?? [];
  const usage = autopilotUsage(steps);
  return (
    <main className={styles.root} hidden={!active} inert={!active || blocked} aria-hidden={!active} aria-label="Autopilot">
      <TieredHeader className={styles.header} style={draggableWindowRegionStyle}
        primary={<>
          <div className={styles.title}>
            <NeumorphicButton raised aria-hidden="true" className={`theme-toggle ${styles.titleMark}`} disabled>
              <Navigation aria-hidden="true" />
            </NeumorphicButton>
            <h1>Autopilot</h1><BetaBadge />
          </div>
          <NeumorphicButton raised size="icon" style={nonDraggableWindowRegionStyle}
            aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
            aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></NeumorphicButton>
        </>} />
      <form className={styles.controls} onSubmit={event => { event.preventDefault(); if (!running) void execute('start'); }}>
        <div className={styles.inputRow} data-disabled={running || pending}>
          <Link className={styles.inputIcon} aria-hidden="true" />
          <NeumorphicTextField ref={urlInput} aria-label="Start URL" value={url} type="url" required
            placeholder="Start URL — https://example.com" maxLength={8192} disabled={running || pending}
            onChange={event => setUrl(event.target.value)} trailingAction={url && <SearchClearButton aria-label="Clear start URL"
              title="Clear start URL" disabled={running || pending} onClick={() => { setUrl(''); urlInput.current?.focus(); }} />} />
        </div>
        <div className={styles.inputRow} data-disabled={running || pending}>
          <Target className={styles.inputIcon} aria-hidden="true" />
          <NeumorphicTextField ref={goalInput} aria-label="Goal" value={goal} required
            maxLength={2000} disabled={running || pending} placeholder="Goal — where would you like to go?"
            onChange={event => setGoal(event.target.value)} trailingAction={goal && <SearchClearButton aria-label="Clear goal"
              title="Clear goal" disabled={running || pending} onClick={() => { setGoal(''); goalInput.current?.focus(); }} />} />
        </div>
        <div className={styles.inputRow} data-disabled={running || pending}>
          <Search className={styles.inputIcon} aria-hidden="true" />
          <NeumorphicTextField ref={searchInput} aria-label="Search text" value={searchText} maxLength={500} disabled={running || pending}
            placeholder={research ? 'Search hint (optional) — terms to help plan the searches' : 'Search text (optional) — exact text to enter on the page'}
            onChange={event => setSearchText(event.target.value)} trailingAction={searchText && <SearchClearButton aria-label="Clear search text"
              title="Clear search text" disabled={running || pending} onClick={() => { setSearchText(''); searchInput.current?.focus(); }} />} />
        </div>
        {research && <label className={styles.sourceLimit}>Source limit<NeumorphicTextField aria-label="Source target" type="number" min={1} max={10} step={1} required
          value={targetSources} disabled={running || pending} onChange={event => setTargetSources(event.target.value)} /></label>}
        <div className={styles.controlActions}>
          <div className={styles.modes} role="group" aria-label="Autopilot mode">
            <NeumorphicButton size="standard" aria-pressed={!research} disabled={running || pending} onClick={() => setResearch(false)}>Navigate</NeumorphicButton>
            <NeumorphicButton size="standard" aria-pressed={research} disabled={running || pending} onClick={() => setResearch(true)}>Research</NeumorphicButton>
          </div>
          {running ? <NeumorphicButton size="standard" disabled={pending} onClick={() => void execute('stop')}>
            <Square aria-hidden="true" />Stop</NeumorphicButton>
            : <NeumorphicButton size="standard" type="submit"
              disabled={pending || !api || !state?.configured || !safeAutopilotUrl(url) || !goal.trim()
                || (research && (!Number.isInteger(Number(targetSources)) || Number(targetSources) < 1 || Number(targetSources) > 10))}>
              <Play aria-hidden="true" />Start</NeumorphicButton>}
        </div>
      </form>
      {!api && <p className={styles.notice}>Autopilot is available in the Cheshi desktop app.</p>}
      {api && state && !state.configured && <p className={styles.notice}>Register your TypeSafe API key in Settings to enable Autopilot.</p>}
      {currentError && <p className={styles.notice} role="alert">{currentError}</p>}
      {exportNotice && <p className={styles.notice} role="status">{exportNotice}</p>}
      <div className={styles.status} role="status">
        <span>{state ? state.mode === 'research' && state.phase === 'completed' ? 'Research report ready' : phaseLabels[state.phase]
          : api ? 'Connecting…' : 'Not connected'}</span>
        <span>{usage.navigation} / {AUTOPILOT_MAX_STEPS} {state?.mode === 'research' ? 'navigation' : 'actions'}</span>
        {state?.mode === 'research' && <span>{usage.readings} / {AUTOPILOT_MAX_READS} document reads</span>}
        <span>Model {seconds(state?.modelMs ?? 0)}</span>
        <span>Browser {seconds(steps.reduce((sum, step) => sum + step.loadMs, 0))}</span>
      </div>
      <div className={styles.content}>
        <div className={styles.browser}>
          <div className={styles.address} title={state?.url}>{state?.url || 'Your browser session will appear here.'}</div>
          <div className={styles.viewport} ref={viewport} aria-label="Autopilot browser">
            {!state?.url && <EmptyState className={styles.empty}
              title="Choose a starting page and tell Autopilot where to go."
              description={research ? 'Codex plans and writes using collected evidence. Jev reads pages and chooses browser actions.'
                : 'Page text, controls and search text are sent to TypeSafe while a run is active.'} />}
          </div>
        </div>
        <LiquidGlassPanel as="aside" className={styles.history} aria-label="Navigation history">
          {state?.mode === 'research' && <AutopilotResearchResults state={state} exporting={exporting} onExport={format => void exportReport(format)} />}
          <h2>Journey</h2>
          {!steps.length && <p>Pages visited will appear here.</p>}
          <ol>{steps.map((step, index) => <li key={`${index}:${step.url}`}>
            <span className={styles.stepNumber}>{index === 0 ? 'Start' : index}</span>
            <div><strong>{step.title || step.url}</strong><span className={styles.stepUrl} title={step.url}>{step.url}</span>
              {step.action && <small>{step.action}</small>}
              <small>Browser {seconds(step.loadMs)}{index > 0 && ` · Model ${seconds(step.decisionMs)}`}</small>
            </div>
          </li>)}</ol>
        </LiquidGlassPanel>
      </div>
    </main>
  );
}
