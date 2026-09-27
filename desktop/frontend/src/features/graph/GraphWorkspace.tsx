import { Crosshair, FileCode2, PanelRight, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { SidebarToggle, EmptyState, NeumorphicButton, TieredHeader, LoadingIndicator, Tooltip } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { useAutoHideScrollbars } from '../../shared/useAutoHideScrollbars';
import badgeStyles from '../../shared/ui/Badge.module.css';
import { SidebarPanelTitle } from '../../shared/ui/SidebarPanelHeader';
import { WorkspaceLayoutControls } from '../shell/WorkspaceLayoutControls';
import { GraphScene } from './GraphScene';
import { GraphViewControls } from './GraphViewControls';
import type { GraphController } from './useGraphController';

interface GraphWorkspaceProps {
  graph: GraphController;
  inspector: ReactNode;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
  onCloseWorkspace?: () => void;
}

export function GraphWorkspace({ graph, inspector, rightSidebarOpen, onToggleRightSidebar, onCloseWorkspace }: GraphWorkspaceProps) {
  const scrollbarSurface = useAutoHideScrollbars<HTMLElement>();
  return (
    <section ref={scrollbarSurface} className="codegraph-workspace" aria-label="CodeGraph relationship graph">
      <TieredHeader
        className="codegraph-toolbar"
        primary={(
          <>
            <div className="codegraph-toolbar-heading">
              <div className="codegraph-toolbar-title">
                <SidebarPanelTitle
                  icon={<Crosshair aria-hidden="true" />}
                  title="Relationship Graph"
                />
              </div>
              {(graph.graph || graph.loading) && (
                <div className="codegraph-summary-status" aria-live="polite">
                  {graph.loading && <LoadingIndicator label="Loading graph" />}
                  {graph.graph && <span>{graph.graphSummary}</span>}
                </div>
              )}
            </div>
            <div className="codegraph-toolbar-actions">
              <WorkspaceLayoutControls />
              <Tooltip content={rightSidebarOpen ? 'Hide right sidebar' : 'Show right sidebar'}>
                {trigger => <SidebarToggle
                  {...trigger}
                  variant="ghost"
                  size="icon"
                  aria-label={rightSidebarOpen ? 'Hide right sidebar' : 'Show right sidebar'}
                  aria-expanded={rightSidebarOpen}
                  onClick={onToggleRightSidebar}
                >
                  <PanelRight aria-hidden="true" />
                </SidebarToggle>}
              </Tooltip>
              {onCloseWorkspace && <TooltipButton raised size="icon"
                aria-label="Close Relationship Graph workspace" title="Close Relationship Graph workspace"
                onClick={onCloseWorkspace}><X aria-hidden="true" /></TooltipButton>}
            </div>
          </>
        )}
      />
      <div className="codegraph-workspace-body">
        <div className="codegraph-workspace-content">
          {(graph.errorMessage || graph.graphError) && (
            <div className="codegraph-error" role="alert">
              <TriangleAlert aria-hidden="true" />
              <span>{graph.errorMessage || graph.graphError}</span>
            </div>
          )}
          {!graph.graph && !graph.loading ? (
            <EmptyState
              className="codegraph-empty-state"
              title="Open a relationship graph"
              description="Select a symbol in Explore to view call, reference, and import relationships."
            />
          ) : (
            <div
              ref={graph.graphViewportRef}
              className={`codegraph-canvas${graph.isPanning ? ' is-panning' : ''}`}
              onPointerDown={graph.handleGraphPointerDown}
              onPointerMove={graph.handleGraphPointerMove}
              onPointerUp={graph.endGraphPan}
              onPointerCancel={graph.endGraphPan}
            >
              <div ref={graph.graphHostRef} className="codegraph-stage" style={graph.graphTransformStyle}>
                {graph.graph && (
                  <GraphScene
                    graph={graph.graph}
                    selectedId={graph.selectedId}
                    displayPath={graph.displayPath}
                    onSelectNode={graph.selectNode}
                  />
                )}
              </div>
            </div>
          )}
          {graph.graph && <GraphViewControls graph={graph} />}
        </div>
        {inspector}
      </div>
    </section>
  );
}

interface GraphDetailsProps {
  graph: GraphController;
  openWorkspaceFile: (path: string, line: number | null) => void;
}

export function GraphDetails({ graph, openWorkspaceFile }: GraphDetailsProps) {
  const details = graph.details;
  return (
    <div className="codegraph-details" aria-label="Selected symbol details">
      <p className="codegraph-selected-summary">{graph.selectedSummary}</p>
      {details ? (
        <>
          <div className="codegraph-symbol-meta">
            <span className={badgeStyles.badge}>{details.node.kind}</span>
            <span className={badgeStyles.badge}>{details.node.language}</span>
            <span className={badgeStyles.badge}>Lines {details.node.startLine}–{details.node.endLine}</span>
          </div>
          <NeumorphicButton variant="ghost" className="codegraph-open-file" type="button" onClick={() => openWorkspaceFile(details.node.filePath, details.node.startLine)}>
            <FileCode2 aria-hidden="true" />
            Open file at line {details.node.startLine}
          </NeumorphicButton>
          <RelationList title="Callers" relations={details.callers} onSelect={graph.selectRelation} />
          <RelationList title="Callees" relations={details.callees} onSelect={graph.selectRelation} />
        </>
      ) : (
        <p className="codegraph-hint">Select a node to view its file location, callers, callees, and source.</p>
      )}
    </div>
  );
}

function RelationList({
  title,
  relations,
  onSelect,
}: {
  title: string;
  relations: NonNullable<GraphController['details']>['callers'];
  onSelect: GraphController['selectRelation'];
}) {
  if (relations.length === 0) return null;

  return (
    <section className="codegraph-relations">
      <header><strong>{title}</strong><span className={badgeStyles.badge}>{relations.length}</span></header>
      {relations.map((relation) => (
        <NeumorphicButton variant="ghost" key={`${relation.id}-${relation.edge}`} type="button" onClick={() => onSelect(relation)}>
          <span>{relation.name}</span>
          <small>{relation.edge}</small>
        </NeumorphicButton>
      ))}
    </section>
  );
}
