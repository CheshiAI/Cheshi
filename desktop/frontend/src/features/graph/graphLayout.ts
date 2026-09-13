import type { GraphEdge, GraphNode, GraphSlice } from './types';

type GraphSide = -1 | 0 | 1;

export interface PositionedGraphNode {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  side: GraphSide;
  incomingCount: number;
  outgoingCount: number;
}

export interface PositionedGraphEdge {
  id: string;
  edge: GraphEdge;
  count: number;
  path: string;
  labelX: number;
  labelY: number;
}

export interface GraphLane {
  id: string;
  title: string;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  side: Exclude<GraphSide, 0>;
  depth: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: PositionedGraphNode[];
  edges: PositionedGraphEdge[];
  lanes: GraphLane[];
}

interface VisitInfo {
  depth: number;
  side: GraphSide;
}

interface Neighbor {
  id: string;
  edge: GraphEdge;
}

interface AggregatedGraphEdge {
  edge: GraphEdge;
  count: number;
}

const NODE_WIDTH = 208;
const NODE_HEIGHT = 78;
const ROOT_WIDTH = 244;
const ROOT_HEIGHT = 96;
const COLUMN_GAP = 40;
const ROW_GAP = 18;
const LANE_GAP = 112;
const LANE_PADDING = 22;
const LANE_HEADER_HEIGHT = 42;
const OUTER_PADDING = 72;

function compareNodes(left: GraphNode, right: GraphNode): number {
  return left.group.localeCompare(right.group)
    || left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name)
    || left.filePath.localeCompare(right.filePath)
    || left.startLine - right.startLine;
}

function rowsForNodeCount(count: number): number {
  return Math.max(1, Math.min(10, Math.ceil(Math.sqrt(count * 1.7))));
}

function aggregateEdges(edges: GraphEdge[]): AggregatedGraphEdge[] {
  const aggregated = new Map<string, AggregatedGraphEdge>();
  for (const edge of edges) {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    aggregated.set(key, { edge, count: 1 });
  }
  return [...aggregated.values()];
}

function sideFromRootEdge(edge: GraphEdge, rootId: string): Exclude<GraphSide, 0> {
  if (edge.target === rootId && edge.source !== rootId) return -1;
  return 1;
}

function buildVisitInfo(slice: GraphSlice, rootId: string): Map<string, VisitInfo> {
  const neighbors = new Map<string, Neighbor[]>();
  for (const node of slice.nodes) neighbors.set(node.id, []);
  for (const edge of slice.edges) {
    if (!neighbors.has(edge.source) || !neighbors.has(edge.target) || edge.source === edge.target) continue;
    neighbors.get(edge.source)?.push({ id: edge.target, edge });
    neighbors.get(edge.target)?.push({ id: edge.source, edge });
  }

  const visits = new Map<string, VisitInfo>([[rootId, { depth: 0, side: 0 }]]);
  const queue = [rootId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentId = queue[cursor];
    if (!currentId) continue;
    const current = visits.get(currentId);
    if (!current) continue;
    for (const neighbor of neighbors.get(currentId) ?? []) {
      if (visits.has(neighbor.id)) continue;
      visits.set(neighbor.id, {
        depth: current.depth + 1,
        side: current.depth === 0 ? sideFromRootEdge(neighbor.edge, rootId) : current.side,
      });
      queue.push(neighbor.id);
    }
  }

  let leftCount = [...visits.values()].filter((visit) => visit.side === -1).length;
  let rightCount = [...visits.values()].filter((visit) => visit.side === 1).length;
  const disconnectedDepth = Math.max(1, ...[...visits.values()].map((visit) => visit.depth)) + 1;
  for (const node of slice.nodes) {
    if (visits.has(node.id)) continue;
    const side = leftCount <= rightCount ? -1 : 1;
    visits.set(node.id, { depth: disconnectedDepth, side });
    if (side === -1) leftCount += 1;
    else rightCount += 1;
  }
  return visits;
}

function bezierMidpoint(start: number, controlOne: number, controlTwo: number, end: number): number {
  return start * 0.125 + controlOne * 0.375 + controlTwo * 0.375 + end * 0.125;
}

function edgeGeometry(
  source: PositionedGraphNode,
  target: PositionedGraphNode,
  parallelOffset: number,
): Pick<PositionedGraphEdge, 'path' | 'labelX' | 'labelY'> {
  const sourceCenterX = source.x + source.width / 2;
  const sourceCenterY = source.y + source.height / 2;
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;
  const deltaX = targetCenterX - sourceCenterX;
  const deltaY = targetCenterY - sourceCenterY;

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    const direction = deltaX >= 0 ? 1 : -1;
    const startX = sourceCenterX + direction * source.width / 2;
    const startY = sourceCenterY;
    const endX = targetCenterX - direction * target.width / 2;
    const endY = targetCenterY;
    const curve = Math.max(44, Math.abs(endX - startX) * 0.42);
    const controlOneX = startX + direction * curve;
    const controlOneY = startY + parallelOffset;
    const controlTwoX = endX - direction * curve;
    const controlTwoY = endY + parallelOffset;
    return {
      path: `M ${startX} ${startY} C ${controlOneX} ${controlOneY}, ${controlTwoX} ${controlTwoY}, ${endX} ${endY}`,
      labelX: bezierMidpoint(startX, controlOneX, controlTwoX, endX),
      labelY: bezierMidpoint(startY, controlOneY, controlTwoY, endY),
    };
  }

  const direction = deltaY >= 0 ? 1 : -1;
  const startX = sourceCenterX;
  const startY = sourceCenterY + direction * source.height / 2;
  const endX = targetCenterX;
  const endY = targetCenterY - direction * target.height / 2;
  const curve = Math.max(38, Math.abs(endY - startY) * 0.42);
  const controlOneX = startX + parallelOffset;
  const controlOneY = startY + direction * curve;
  const controlTwoX = endX + parallelOffset;
  const controlTwoY = endY - direction * curve;
  return {
    path: `M ${startX} ${startY} C ${controlOneX} ${controlOneY}, ${controlTwoX} ${controlTwoY}, ${endX} ${endY}`,
    labelX: bezierMidpoint(startX, controlOneX, controlTwoX, endX),
    labelY: bezierMidpoint(startY, controlOneY, controlTwoY, endY),
  };
}

export function layoutGraph(slice: GraphSlice): GraphLayout {
  const root = slice.nodes.find((node) => node.id === slice.rootId) ?? slice.nodes[0];
  if (!root) return { width: 0, height: 0, nodes: [], edges: [], lanes: [] };

  const visits = buildVisitInfo(slice, root.id);
  const incomingCounts = new Map<string, number>();
  const outgoingCounts = new Map<string, number>();
  for (const edge of slice.edges) {
    outgoingCounts.set(edge.source, (outgoingCounts.get(edge.source) ?? 0) + 1);
    incomingCounts.set(edge.target, (incomingCounts.get(edge.target) ?? 0) + 1);
  }

  const positionedNodes: PositionedGraphNode[] = [{
    node: root,
    x: -ROOT_WIDTH / 2,
    y: -ROOT_HEIGHT / 2,
    width: ROOT_WIDTH,
    height: ROOT_HEIGHT,
    depth: 0,
    side: 0,
    incomingCount: incomingCounts.get(root.id) ?? 0,
    outgoingCount: outgoingCounts.get(root.id) ?? 0,
  }];
  const lanes: GraphLane[] = [];

  for (const side of [-1, 1] as const) {
    const depthGroups = new Map<number, GraphNode[]>();
    for (const node of slice.nodes) {
      if (node.id === root.id) continue;
      const visit = visits.get(node.id);
      if (!visit || visit.side !== side) continue;
      const group = depthGroups.get(visit.depth) ?? [];
      group.push(node);
      depthGroups.set(visit.depth, group);
    }

    let cursor = side === -1 ? -ROOT_WIDTH / 2 - LANE_GAP : ROOT_WIDTH / 2 + LANE_GAP;
    for (const [depth, nodes] of [...depthGroups.entries()].sort(([left], [right]) => left - right)) {
      nodes.sort(compareNodes);
      const rowCount = rowsForNodeCount(nodes.length);
      const columnCount = Math.ceil(nodes.length / rowCount);
      const contentWidth = columnCount * NODE_WIDTH + Math.max(0, columnCount - 1) * COLUMN_GAP;
      const contentHeight = rowCount * NODE_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP;
      const contentY = -contentHeight / 2;
      const laneX = side === -1 ? cursor - contentWidth - LANE_PADDING : cursor - LANE_PADDING;
      const laneY = contentY - LANE_HEADER_HEIGHT;
      const laneWidth = contentWidth + LANE_PADDING * 2;
      const laneHeight = contentHeight + LANE_HEADER_HEIGHT + LANE_PADDING;

      lanes.push({
        id: `${side}-${depth}`,
        title: `${side === -1 ? 'Incoming' : 'Outgoing'} · ${depth} ${depth === 1 ? 'hop' : 'hops'}`,
        count: nodes.length,
        x: laneX,
        y: laneY,
        width: laneWidth,
        height: laneHeight,
        side,
        depth,
      });

      nodes.forEach((node, index) => {
        const column = Math.floor(index / rowCount);
        const row = index % rowCount;
        const x = side === -1
          ? cursor - NODE_WIDTH - column * (NODE_WIDTH + COLUMN_GAP)
          : cursor + column * (NODE_WIDTH + COLUMN_GAP);
        positionedNodes.push({
          node,
          x,
          y: contentY + row * (NODE_HEIGHT + ROW_GAP),
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          depth,
          side,
          incomingCount: incomingCounts.get(node.id) ?? 0,
          outgoingCount: outgoingCounts.get(node.id) ?? 0,
        });
      });

      cursor = side === -1 ? laneX - LANE_GAP : laneX + laneWidth + LANE_GAP;
    }
  }

  const allLeft = Math.min(...positionedNodes.map((node) => node.x), ...lanes.map((lane) => lane.x));
  const allTop = Math.min(...positionedNodes.map((node) => node.y), ...lanes.map((lane) => lane.y));
  const allRight = Math.max(
    ...positionedNodes.map((node) => node.x + node.width),
    ...lanes.map((lane) => lane.x + lane.width),
  );
  const allBottom = Math.max(
    ...positionedNodes.map((node) => node.y + node.height),
    ...lanes.map((lane) => lane.y + lane.height),
  );
  const offsetX = OUTER_PADDING - allLeft;
  const offsetY = OUTER_PADDING - allTop;
  for (const node of positionedNodes) {
    node.x += offsetX;
    node.y += offsetY;
  }
  for (const lane of lanes) {
    lane.x += offsetX;
    lane.y += offsetY;
  }

  const nodeById = new Map(positionedNodes.map((node) => [node.node.id, node]));
  const aggregatedEdges = aggregateEdges(slice.edges);
  const parallelTotals = new Map<string, number>();
  for (const { edge } of aggregatedEdges) {
    const key = `${edge.source}\u0000${edge.target}`;
    parallelTotals.set(key, (parallelTotals.get(key) ?? 0) + 1);
  }
  const parallelIndexes = new Map<string, number>();
  const positionedEdges = aggregatedEdges.flatMap(({ edge, count }, index): PositionedGraphEdge[] => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return [];
    const key = `${edge.source}\u0000${edge.target}`;
    const parallelIndex = parallelIndexes.get(key) ?? 0;
    parallelIndexes.set(key, parallelIndex + 1);
    const parallelTotal = parallelTotals.get(key) ?? 1;
    const parallelOffset = (parallelIndex - (parallelTotal - 1) / 2) * 10;
    return [{
      id: `${edge.source}-${edge.target}-${edge.kind}-${index}`,
      edge,
      count,
      ...edgeGeometry(source, target, parallelOffset),
    }];
  });

  return {
    width: Math.ceil(allRight - allLeft + OUTER_PADDING * 2),
    height: Math.ceil(allBottom - allTop + OUTER_PADDING * 2),
    nodes: positionedNodes,
    edges: positionedEdges,
    lanes,
  };
}
