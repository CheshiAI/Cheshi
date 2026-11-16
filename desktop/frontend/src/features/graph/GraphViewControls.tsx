import { Minus, Plus, X } from 'lucide-react';

import { LiquidGlassPanel } from '../../shared/ui';
import { TooltipButton } from '../../shared/ui/TooltipButton';
import { GraphZoomInput } from './GraphZoomInput';
import type { GraphController } from './useGraphController';

export function GraphViewControls({ graph }: { graph: GraphController }) {
  return (
    <LiquidGlassPanel className="codegraph-graph-controls" role="group" aria-label="Graph view controls">
      <TooltipButton variant="ghost" size="icon" onClick={graph.zoomOut} aria-label="Zoom out" title="Zoom out">
        <Minus aria-hidden="true" />
      </TooltipButton>
      <GraphZoomInput percent={graph.zoomPercent} onCommit={graph.setZoomPercent} />
      <TooltipButton variant="ghost" size="icon" onClick={graph.zoomIn} aria-label="Zoom in" title="Zoom in">
        <Plus aria-hidden="true" />
      </TooltipButton>
      <TooltipButton variant="ghost" onClick={graph.fitGraph} title="Fit graph">Fit</TooltipButton>
      <TooltipButton variant="ghost" onClick={graph.resetGraphView} aria-label="Reset graph zoom to 100%" title="Reset graph zoom to 100%">100%</TooltipButton>
      <TooltipButton variant="ghost" size="icon" onClick={graph.closeGraphView} aria-label="Close graph" title="Close graph">
        <X aria-hidden="true" />
      </TooltipButton>
    </LiquidGlassPanel>
  );
}
