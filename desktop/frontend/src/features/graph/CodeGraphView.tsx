import { Network } from 'lucide-react';
import { useEffect, useState } from 'react';

import { LiquidGlassPanel } from '../../shared/ui';
import { cheshiDesktop as desktopApi } from '../../cheshiDesktop';
import { GraphInspector } from './GraphInspector';
import { GraphWorkspace } from './GraphWorkspace';
import { useGraphController } from './useGraphController';

interface CodeGraphViewProps {
  onOpenWorkspaceFile: (path: string, line: number | null) => void;
  rightSidebarOpen: boolean;
  onToggleRightSidebar: () => void;
}

export function CodeGraphView({ onOpenWorkspaceFile, rightSidebarOpen, onToggleRightSidebar }: CodeGraphViewProps) {
  const [indexed, setIndexed] = useState<boolean | null>(null);
  const graph = useGraphController(indexed === true);

  useEffect(() => {
    if (!desktopApi) {
      setIndexed(true);
      return;
    }
    void desktopApi.isCodeGraphIndexed()
      .then(setIndexed)
      .catch(() => setIndexed(false));
  }, []);

  if (indexed === null) {
    return <main className="codegraph-unavailable"><span className="codegraph-spinner" />Checking CodeGraph status</main>;
  }

  if (!indexed) {
    return (
      <main className="codegraph-unavailable">
        <Network aria-hidden="true" />
        <strong>CodeGraph index required</strong>
        <span>Run cheshi-cli codegraph init for the current Workspace, then restart the app.</span>
      </main>
    );
  }

  return (
    <LiquidGlassPanel as="main" className="codegraph-view">
      <GraphWorkspace
        graph={graph}
        rightSidebarOpen={rightSidebarOpen}
        onToggleRightSidebar={onToggleRightSidebar}
        inspector={<GraphInspector graph={graph} openWorkspaceFile={onOpenWorkspaceFile} />}
      />
    </LiquidGlassPanel>
  );
}
