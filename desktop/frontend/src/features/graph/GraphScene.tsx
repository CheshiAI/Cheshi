import { useEffect, useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';

import { layoutGraph, type PositionedGraphNode } from './graphLayout';
import type { GraphSlice } from './types';

interface GraphSceneProps {
  graph: GraphSlice;
  selectedId: string;
  displayPath: (path: string) => string;
  onSelectNode: (nodeId: string) => void;
}

function compactText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  const tailLength = Math.ceil(maximumLength * 0.55);
  const headLength = maximumLength - tailLength - 1;
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function readableKind(value: string): string {
  return value.replaceAll('_', ' ');
}

function markerSafeKind(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
}

function GraphNodeCard({
  positioned,
  selected,
  dimmed,
  displayPath,
  onSelect,
  onHover,
}: {
  positioned: PositionedGraphNode;
  selected: boolean;
  dimmed: boolean;
  displayPath: GraphSceneProps['displayPath'];
  onSelect: () => void;
  onHover: (hovered: boolean) => void;
}) {
  const { node, width, height, incomingCount, outgoingCount } = positioned;
  const root = positioned.depth === 0;
  const location = `${displayPath(node.filePath)}:${node.startLine}`;
  const title = node.qualifiedName === node.filePath || node.qualifiedName === displayPath(node.filePath)
    ? `${node.name}\n${location}`
    : `${node.qualifiedName}\n${location}`;
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect();
  };

  return (
    <g transform={`translate(${positioned.x} ${positioned.y})`}>
      <g
        className={`codegraph-node${root ? ' is-root' : ''}${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`}
        data-kind={node.kind}
        role="button"
        tabIndex={0}
        aria-label={`Select ${node.name}, ${readableKind(node.kind)}`}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
      >
        <title>{title}</title>
        <rect className="codegraph-node-halo" x="-5" y="-5" width={width + 10} height={height + 10} rx={root ? 21 : 17} />
        <rect className="codegraph-node-shell" width={width} height={height} rx={root ? 16 : 12} />
        <rect className="codegraph-node-accent" x="0" y={root ? 15 : 13} width="4" height={height - (root ? 30 : 26)} rx="2" />
        <circle className="codegraph-node-kind-dot" cx={root ? 22 : 20} cy={root ? 22 : 19} r={root ? 5 : 4} />
        <text className="codegraph-node-kind" x={root ? 34 : 31} y={root ? 26 : 23}>
          {root ? 'Focus' : readableKind(node.kind)}
        </text>
        <text className="codegraph-node-language" x={width - 14} y={root ? 26 : 23} textAnchor="end">
          {root ? `${incomingCount} in · ${outgoingCount} out` : node.language}
        </text>
        <text className="codegraph-node-name" x={root ? 18 : 15} y={root ? 56 : 47}>
          {compactText(node.name, root ? 29 : 25)}
        </text>
        <text className="codegraph-node-location" x={root ? 18 : 15} y={root ? 79 : 67}>
          {compactText(location, root ? 35 : 31)}
        </text>
      </g>
    </g>
  );
}

export function GraphScene({ graph, selectedId, displayPath, onSelectNode }: GraphSceneProps) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const markerPrefix = useId().replaceAll(':', '');
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const edgeKinds = useMemo(() => [...new Set(layout.edges.map(({ edge }) => edge.kind))], [layout.edges]);
  const connectedNodeIds = useMemo(() => {
    if (!hoveredNodeId) return null;
    const connected = new Set([hoveredNodeId]);
    for (const { edge } of layout.edges) {
      if (edge.source === hoveredNodeId) connected.add(edge.target);
      if (edge.target === hoveredNodeId) connected.add(edge.source);
    }
    return connected;
  }, [hoveredNodeId, layout.edges]);

  useEffect(() => {
    setHoveredNodeId(null);
    setHoveredEdgeId(null);
  }, [graph]);

  return (
    <svg
      className="codegraph-scene"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="group"
      aria-label={`Relationship graph with ${layout.nodes.length} nodes and ${graph.edges.length} relations across ${layout.edges.length} connections`}
    >
      <defs>
        {edgeKinds.map((kind) => (
          <marker
            key={kind}
            id={`${markerPrefix}-${markerSafeKind(kind)}`}
            className="codegraph-edge-marker"
            data-kind={kind}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="10"
            markerHeight="10"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        ))}
      </defs>

      <g className="codegraph-lanes" aria-hidden="true">
        {layout.lanes.map((lane) => (
          <g key={lane.id} className="codegraph-lane" data-side={lane.side === -1 ? 'incoming' : 'outgoing'}>
            <rect x={lane.x} y={lane.y} width={lane.width} height={lane.height} rx="22" />
            <text className="codegraph-lane-title" x={lane.x + 18} y={lane.y + 25}>{lane.title}</text>
            <text className="codegraph-lane-count" x={lane.x + lane.width - 18} y={lane.y + 25} textAnchor="end">
              {lane.count}
            </text>
          </g>
        ))}
      </g>

      <g className="codegraph-edges">
        {layout.edges.map((positionedEdge) => {
          const { edge } = positionedEdge;
          const connectedToHover = hoveredNodeId === edge.source || hoveredNodeId === edge.target;
          const dimmed = hoveredNodeId !== null && !connectedToHover;
          const relationLabel = `${edge.kind}${positionedEdge.count > 1 ? ` × ${positionedEdge.count}` : ''}`;
          const labelWidth = Math.max(52, relationLabel.length * 6.4 + 18);
          const showConnectedLabel = hoveredNodeId !== null
            && hoveredNodeId !== graph.rootId
            && connectedToHover;
          const edgeStyle = {
            '--codegraph-edge-width': `${(1.4 + Math.min(1.8, Math.log2(positionedEdge.count) * 0.32)) / 16}rem`,
          } as CSSProperties;
          return (
            <g
              key={positionedEdge.id}
              className={`codegraph-edge${connectedToHover ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}`}
              data-kind={edge.kind}
              style={edgeStyle}
            >
              <path
                className="codegraph-edge-path"
                d={positionedEdge.path}
                markerEnd={`url(#${markerPrefix}-${markerSafeKind(edge.kind)})`}
              >
                <title>{relationLabel}</title>
              </path>
              <path
                className="codegraph-edge-hit-area"
                d={positionedEdge.path}
                onMouseEnter={() => setHoveredEdgeId(positionedEdge.id)}
                onMouseLeave={() => setHoveredEdgeId(null)}
              />
              <g
                className={`codegraph-edge-label${hoveredEdgeId === positionedEdge.id || showConnectedLabel ? ' is-visible' : ''}`}
                transform={`translate(${positionedEdge.labelX} ${positionedEdge.labelY})`}
              >
                <rect x={-labelWidth / 2} y="-11" width={labelWidth} height="22" rx="11" />
                <text y="4" textAnchor="middle">{relationLabel}</text>
              </g>
            </g>
          );
        })}
      </g>

      <g className="codegraph-nodes">
        {layout.nodes.map((positionedNode) => (
          <GraphNodeCard
            key={positionedNode.node.id}
            positioned={positionedNode}
            selected={positionedNode.node.id === selectedId}
            dimmed={connectedNodeIds !== null && !connectedNodeIds.has(positionedNode.node.id)}
            displayPath={displayPath}
            onSelect={() => onSelectNode(positionedNode.node.id)}
            onHover={(hovered) => setHoveredNodeId(hovered ? positionedNode.node.id : null)}
          />
        ))}
      </g>
    </svg>
  );
}
