import { LiquidGlassPanel, LoadingIndicator, EmptyState } from '../../shared/ui';
import { GraphInspector } from './GraphInspector';
import { GraphWorkspace } from './GraphWorkspace';
import { useGraphController } from './useGraphController';
import type { CodeGraphIndexController } from './useCodeGraphIndex';

interface CodeGraphViewProps {
  index: CodeGraphIndexController;
  onOpenWorkspaceFile: (path: string, line: number | null) => void;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
  onCloseWorkspace?: () => void;
}

export function CodeGraphView({ index, onOpenWorkspaceFile, rightSidebarOpen, onToggleRightSidebar, onCloseWorkspace }: CodeGraphViewProps) {
  const graph = useGraphController(index.status.state === 'ready');
  const unavailable = index.status.state === 'loading'
    ? <div className="codegraph-empty-state" role="status"><LoadingIndicator label="Checking CodeGraph status" /></div>
    : index.status.state !== 'ready'
      ? <EmptyState className="codegraph-empty-state"
          title={index.status.state === 'not_indexed' ? 'CodeGraph index required' : 'CodeGraph unavailable'}
          description={index.status.message} />
      : undefined;

  return (
    <LiquidGlassPanel as="main" className="codegraph-view">
      <GraphWorkspace
        graph={graph}
        unavailable={unavailable}
        rightSidebarOpen={rightSidebarOpen}
        onToggleRightSidebar={onToggleRightSidebar}
        onCloseWorkspace={onCloseWorkspace}
        inspector={<GraphInspector graph={graph} index={index} openWorkspaceFile={onOpenWorkspaceFile} />}
      />
    </LiquidGlassPanel>
  );
}
