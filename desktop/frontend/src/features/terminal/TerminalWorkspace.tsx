import { AlertTriangle, PanelRight, Plus, SquareTerminal } from 'lucide-react';

import {
  draggableWindowRegionStyle,
  FlatTab,
  FlatTabList,
  NeumorphicButton,
  nonDraggableWindowRegionStyle,
  TieredHeader,
} from '../../shared/ui';
import { TerminalPaneLayout } from './TerminalPaneLayout';
import { TerminalTabIcon } from './TerminalTabIcon';
import { useTerminalController } from './useTerminalController';
import './terminal.css';

interface TerminalWorkspaceProps {
  active: boolean;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

export function TerminalWorkspace({
  active,
  rightSidebarOpen,
  onToggleRightSidebar,
}: TerminalWorkspaceProps) {
  const terminal = useTerminalController(active);
  const { state } = terminal;
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) ?? null;

  if (!active) return null;

  return (
    <main className="terminal-workspace" aria-label="Workspace terminal">
      <TieredHeader
        className="terminal-header"
        primaryClassName={state.sessions.length > 0 ? 'terminal-tab-row' : undefined}
        primary={(
          <>
            {state.sessions.length === 0 ? (
              <div className="terminal-header-title">
                <NeumorphicButton
                  raised
                  aria-hidden="true"
                  className="theme-toggle terminal-header-title-mark"
                  disabled
                >
                  <SquareTerminal aria-hidden="true" />
                </NeumorphicButton>
                <h1>Terminal</h1>
              </div>
            ) : (
              <FlatTabList aria-label="Terminal sessions" onCloseAll={terminal.closeAllSessions}>
                {state.sessions.map((session) => {
                  const selected = session.id === state.activeSessionId;
                  return (
                    <FlatTab
                      active={selected}
                      closeLabel={`Close ${session.title}`}
                      key={session.id}
                      label={session.title}
                      leading={<TerminalTabIcon />}
                      onActivate={() => terminal.selectSession(session.id)}
                      onClose={() => terminal.closeSession(session.id)}
                      style={nonDraggableWindowRegionStyle}
                      title={session.title}
                    />
                  );
                })}
              </FlatTabList>
            )}
            <div className="terminal-header-actions" style={nonDraggableWindowRegionStyle}>
              <NeumorphicButton
                raised
                className="neumorphic-surface terminal-action"
                aria-label="New terminal session"
                title="New terminal session"
                disabled={!state.available}
                onClick={terminal.newSession}
              >
                <Plus aria-hidden="true" />
              </NeumorphicButton>
              <NeumorphicButton
                raised
                type="button"
                aria-label={rightSidebarOpen ? 'Close right sidebar' : 'Open right sidebar'}
                aria-pressed={rightSidebarOpen}
                className="neumorphic-surface codegraph-inspector-toggle"
                onClick={onToggleRightSidebar}
              >
                <PanelRight aria-hidden="true" />
              </NeumorphicButton>
            </div>
          </>
        )}
        style={draggableWindowRegionStyle}
      />

      {terminal.error && (
        <div className="terminal-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{terminal.error}</span>
        </div>
      )}

      <section className="terminal-stage" aria-label="Terminal canvas">
        {activeSession ? (
          <div className="terminal-session">
            <TerminalPaneLayout
              layout={activeSession.layout}
              panes={activeSession.panes}
              activePaneId={state.activePaneId}
              registerHost={terminal.registerHost}
              onSelectPane={(paneId) => terminal.selectPane(activeSession.id, paneId)}
              onSplitPane={(paneId, direction) => terminal.splitPane(activeSession.id, paneId, direction)}
              onResizeSplit={(splitId, ratio) => terminal.resizeSplit(activeSession.id, splitId, ratio)}
              onClosePane={(paneId) => terminal.closePane(activeSession.id, paneId)}
            />
          </div>
        ) : (
          <div className="terminal-empty">
            <strong>{state.available ? 'Start a terminal session' : 'Terminal unavailable'}</strong>
            <p>{terminal.error || 'Open a shell in the current Workspace.'}</p>
            <NeumorphicButton
              raised
              className="neumorphic-surface terminal-new-session"
              disabled={!state.available}
              onClick={terminal.newSession}
            >
              <Plus aria-hidden="true" />
              <span>New session</span>
            </NeumorphicButton>
          </div>
        )}
      </section>
    </main>
  );
}
