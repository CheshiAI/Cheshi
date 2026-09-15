import { ArrowLeft, ArrowRight, ExternalLink, House, PanelRight, PanelsTopLeft, RefreshCw } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { SHOWCASE_URLS, type ShowcaseAction, type ShowcasePage, type ShowcaseState } from '../../../../shared/showcase';
import { cheshiDesktop } from '../../cheshiDesktop';
import { errorMessage } from '../../shared/errorMessage';
import { LoadingState, NeumorphicButton, TieredHeader, draggableWindowRegionStyle, nonDraggableWindowRegionStyle } from '../../shared/ui';
import { observeShowcaseViewport } from './showcaseViewport';
import styles from './ShowcaseView.module.css';

interface ShowcaseViewProps {
  active: boolean;
  blocked: boolean;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

export function ShowcaseView({ active, blocked, rightSidebarOpen, onToggleRightSidebar }: ShowcaseViewProps) {
  const api = cheshiDesktop?.showcase;
  const [page, setPage] = useState<ShowcasePage>('gallery');
  const [states, setStates] = useState<Partial<Record<ShowcasePage, ShowcaseState>>>({});
  const [error, setError] = useState<string | null>(null);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [viewportRetry, setViewportRetry] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const state = states[page];
  const url = state?.url || SHOWCASE_URLS[page];
  const origin = new URL(url).origin;
  const disabled = !api || !active || blocked;

  useLayoutEffect(() => {
    if (!api) return;
    let disposed = false;
    const unsubscribe = api.onState(value => {
      if (!disposed) setStates(current => ({ ...current, [value.page]: value }));
    });
    return () => { disposed = true; unsubscribe(); };
  }, [api]);

  useLayoutEffect(() => {
    requestId.current += 1;
    setError(null);
    setViewportError(null);
    if (!api || !active || blocked || !viewport.current) return;
    return observeShowcaseViewport(viewport.current, api, page,
      cause => setViewportError(errorMessage(cause, 'Could not open Showcase.')));
  }, [api, active, blocked, page, viewportRetry]);

  useLayoutEffect(() => () => { requestId.current += 1; }, []);

  const navigate = async (action: ShowcaseAction): Promise<void> => {
    if (disabled) return;
    const id = ++requestId.current;
    setError(null);
    try { await api.navigate(action); }
    catch (cause) {
      if (id === requestId.current) setError(errorMessage(cause, 'Could not navigate Showcase.'));
    }
  };
  const reload = (): void => {
    if (viewportError) setViewportRetry(current => current + 1);
    else void navigate('reload');
  };
  const currentError = viewportError ?? error ?? state?.error;
  const loading = !!api && active && !blocked && !currentError && (state?.loading ?? true);

  return (
    <main className={styles.root} hidden={!active} inert={!active || blocked} aria-hidden={!active} aria-label="OpenAI Showcase">
      <TieredHeader className={styles.header} primaryClassName={styles.primary} style={draggableWindowRegionStyle}
        primary={<>
          <div className={styles.title}>
            <NeumorphicButton raised aria-hidden="true" className={`theme-toggle ${styles.titleMark}`} disabled>
              <PanelsTopLeft aria-hidden="true" />
            </NeumorphicButton>
            <h1>Showcase</h1>
          </div>
          <div className={styles.actions} style={nonDraggableWindowRegionStyle}>
            <div className={styles.pages} aria-label="Showcase pages">
              <NeumorphicButton size="standard" active={page === 'gallery'} aria-pressed={page === 'gallery'}
                onClick={() => setPage('gallery')}>Explore</NeumorphicButton>
              <NeumorphicButton size="standard" active={page === 'submission'} aria-pressed={page === 'submission'}
                onClick={() => setPage('submission')}>Submit project</NeumorphicButton>
            </div>
            <NeumorphicButton raised size="icon" aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
              aria-pressed={rightSidebarOpen} onClick={onToggleRightSidebar}><PanelRight aria-hidden="true" /></NeumorphicButton>
          </div>
        </>}
        secondary={<div className={styles.browserBar} style={nonDraggableWindowRegionStyle}>
          <div className={styles.navigation}>
            <NeumorphicButton raised size="icon" aria-label="Go back" disabled={disabled || !state?.canGoBack}
              onClick={() => void navigate('back')}><ArrowLeft aria-hidden="true" /></NeumorphicButton>
            <NeumorphicButton raised size="icon" aria-label="Go forward" disabled={disabled || !state?.canGoForward}
              onClick={() => void navigate('forward')}><ArrowRight aria-hidden="true" /></NeumorphicButton>
            <NeumorphicButton raised size="icon" aria-label="Reload page" disabled={disabled}
              onClick={reload}><RefreshCw aria-hidden="true" /></NeumorphicButton>
            <NeumorphicButton raised size="icon" aria-label="Go to official page" disabled={disabled}
              onClick={() => void navigate('home')}><House aria-hidden="true" /></NeumorphicButton>
          </div>
          <span className={styles.origin} title={url}>{origin}</span>
          <NeumorphicButton raised size="icon" aria-label="Open in browser" disabled={disabled}
            onClick={() => void navigate('external')}><ExternalLink aria-hidden="true" /></NeumorphicButton>
        </div>} />
      {page === 'submission' && <p className={styles.note}>Submit a project built with Cheshi. OpenAI reviews submissions.</p>}
      {currentError && <div className={styles.error} role="alert"><span>{currentError}</span>
        <NeumorphicButton size="standard" disabled={disabled} onClick={reload}>Try again</NeumorphicButton>
      </div>}
      <div ref={viewport} className={styles.viewport} aria-busy={loading}
        aria-label={page === 'gallery' ? 'Showcase website' : 'Showcase submission form'}>
        {loading && <LoadingState key={page} className={styles.contentLoading} type="preparing" label="Loading page…" />}
        {!api && <div className={styles.fallback}>
          <p>Explore OpenAI Showcase and submit your project in your browser.</p>
          <a href={SHOWCASE_URLS[page]} target="_blank" rel="noopener noreferrer">{page === 'gallery' ? 'Open Showcase' : 'Open submission form'} <ExternalLink aria-hidden="true" /></a>
        </div>}
      </div>
    </main>
  );
}
