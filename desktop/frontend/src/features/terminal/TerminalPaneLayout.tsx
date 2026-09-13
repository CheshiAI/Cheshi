import { useCallback } from 'react';
import { Columns2, Rows2, X } from 'lucide-react';

import type {
  TerminalPaneLayout as TerminalPaneLayoutState,
  TerminalPaneState,
  TerminalSplitDirection,
} from '../../cheshiDesktop';
import { SplitPaneLayout } from '../../shared/ui/SplitPaneLayout';
import { LiquidGlassPanel } from '../../shared/ui';
import { paneDisplayPath } from './paneTitle';
import { TerminalPaneIcon } from './TerminalPaneIcon';

interface TerminalPaneLayoutProps {
  layout: TerminalPaneLayoutState;
  panes: TerminalPaneState[];
  activePaneId: string | null;
  registerHost: (paneId: string, host: HTMLElement | null) => void;
  onSelectPane: (paneId: string) => void;
  onSplitPane: (paneId: string, direction: TerminalSplitDirection) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onClosePane: (paneId: string) => void;
}

interface TerminalPaneProps {
  pane: TerminalPaneState;
  active: boolean;
  registerHost: (paneId: string, host: HTMLElement | null) => void;
  onSelectPane: (paneId: string) => void;
  onSplitPane: (paneId: string, direction: TerminalSplitDirection) => void;
  onClosePane: (paneId: string) => void;
}

function TerminalPane({
  pane,
  active,
  registerHost,
  onSelectPane,
  onSplitPane,
  onClosePane,
}: TerminalPaneProps) {
  const hostRef = useCallback((host: HTMLDivElement | null): void => {
    registerHost(pane.id, host);
  }, [pane.id, registerHost]);
  const displayPath = paneDisplayPath(pane.title);

  return (
    <section
      className="terminal-pane"
      data-active={active ? 'true' : undefined}
      aria-label={displayPath}
      onPointerDown={() => onSelectPane(pane.id)}
    >
      <LiquidGlassPanel as="header" className="terminal-pane-header" data-liquid-glass-backdrop={active ? 'true' : undefined}>
        <button
          className="terminal-pane-title"
          type="button"
          aria-current={active ? 'page' : undefined}
          title={displayPath}
          onClick={() => onSelectPane(pane.id)}
        >
          <TerminalPaneIcon />
          <span>{displayPath}</span>
        </button>
        <div className="terminal-pane-actions">
          <button
            className="terminal-pane-action"
            type="button"
            aria-label="Split pane right"
            title="Split pane right"
            onClick={(event) => {
              event.stopPropagation();
              onSplitPane(pane.id, 'right');
            }}
          >
            <Columns2 aria-hidden="true" />
          </button>
          <button
            className="terminal-pane-action"
            type="button"
            aria-label="Split pane down"
            title="Split pane down"
            onClick={(event) => {
              event.stopPropagation();
              onSplitPane(pane.id, 'down');
            }}
          >
            <Rows2 aria-hidden="true" />
          </button>
          <button
            className="terminal-pane-action"
            type="button"
            aria-label="Close pane"
            title="Close pane"
            onClick={(event) => {
              event.stopPropagation();
              onClosePane(pane.id);
            }}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </LiquidGlassPanel>
      <div
        ref={hostRef}
        className="terminal-host"
        aria-label="Interactive project terminal"
      />
    </section>
  );
}

export function TerminalPaneLayout({
  layout,
  panes,
  activePaneId,
  registerHost,
  onSelectPane,
  onSplitPane,
  onResizeSplit,
  onClosePane,
}: TerminalPaneLayoutProps) {
  return (
    <SplitPaneLayout
      layout={layout}
      onResizeSplit={onResizeSplit}
      resizeLabel="Resize terminal panes"
      renderPane={(paneId) => {
        const pane = panes.find((candidate) => candidate.id === paneId);
        return pane ? (
          <TerminalPane
            pane={pane}
            active={pane.id === activePaneId}
            registerHost={registerHost}
            onSelectPane={onSelectPane}
            onSplitPane={onSplitPane}
            onClosePane={onClosePane}
          />
        ) : null;
      }}
    />
  );
}
