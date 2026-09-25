import { createPortal } from 'react-dom';
import { SplitPreview, type SplitPreviewDirection } from '../../shared/ui/SplitPreview';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Columns2, Rows2, SquareTerminal, X } from 'lucide-react';

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
  onSplitPane: (paneId: string, direction: TerminalSplitDirection) => void | Promise<boolean>;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onClosePane: (paneId: string) => void;
}

interface TerminalPaneProps {
  host: HTMLDivElement;
  pane: TerminalPaneState;
  active: boolean;
  registerHost: (paneId: string, host: HTMLElement | null) => void;
  onSelectPane: (paneId: string) => void;
  onSplitPane: (paneId: string, direction: TerminalSplitDirection) => void | Promise<boolean>;
  onClosePane: (paneId: string) => void;
}

function TerminalPane({
  host,
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
  const paneRef = useRef<HTMLElement>(null);
  const [splitChoice, setSplitChoice] = useState<SplitPreviewDirection | null>(null);

  return createPortal(
    <section
      ref={paneRef}
      tabIndex={-1}
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
              setSplitChoice('right');
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
              setSplitChoice('down');
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
      {splitChoice && paneRef.current && <SplitPreview target={paneRef.current} direction={splitChoice}
        title={splitChoice === 'right' ? 'Split terminal right' : 'Split terminal down'}
        choices={[{ id: 'terminal', label: 'Terminal', icon: <SquareTerminal aria-hidden="true" />, description: 'Start a new shell.' }]}
        onChoose={async () => (await onSplitPane(pane.id, splitChoice)) !== false}
        onClose={() => setSplitChoice(null)} /> }
    </section>, host, pane.id,
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
  const hosts = useRef(new Map<string, HTMLDivElement>());
  for (const pane of panes) {
    if (!hosts.current.has(pane.id)) {
      const host = document.createElement('div');
      host.className = 'terminal-pane-mount';
      hosts.current.set(pane.id, host);
    }
  }
  useEffect(() => {
    const current = new Set(panes.map(pane => pane.id));
    for (const id of hosts.current.keys()) if (!current.has(id)) hosts.current.delete(id);
  }, [panes]);
  return <>
    <SplitPaneLayout layout={layout} onResizeSplit={onResizeSplit} resizeLabel="Resize terminal panes"
      renderPane={id => <TerminalPaneMount host={hosts.current.get(id)!} />} />
    {panes.map(pane => <TerminalPane key={pane.id} pane={pane} host={hosts.current.get(pane.id)!}
      active={pane.id === activePaneId} registerHost={registerHost} onSelectPane={onSelectPane}
      onSplitPane={onSplitPane} onClosePane={onClosePane} />)}
  </>;
}

function TerminalPaneMount({ host }: { host: HTMLDivElement }) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    mount.current?.append(host);
    return () => host.remove();
  }, [host]);
  return <div className="terminal-pane-mount" ref={mount} />;
}
