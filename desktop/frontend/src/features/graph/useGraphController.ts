import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import type {
  GraphSlice,
  GroupBy,
  Meta,
  NodeDetails,
  ProjectOption,
  Relation,
  SearchResult,
} from './types';
import { readViewerState, VIEWER_STATE_STORAGE_KEY, type ViewerStateSnapshot } from './model';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const WHEEL_LINE_HEIGHT = 16;
const TRACKPAD_ZOOM_SENSITIVITY = 0.0025;
const preferredEdges = new Set(['calls', 'imports', 'references']);

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  let body: T | { error?: string };
  try {
    body = JSON.parse(text) as T | { error?: string };
  } catch {
    throw new Error('CodeGraph Viewer API is unavailable. Check the index and Viewer status.');
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      ? body.error
      : undefined;
    throw new Error(message || `Request failed (${response.status})`);
  }
  return body as T;
}

function withProject(url: string, projectId: string): string {
  if (!projectId) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}project=${encodeURIComponent(projectId)}`;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function wheelDeltaInPixels(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) return delta * WHEEL_LINE_HEIGHT;
  if (deltaMode === 2) return delta * pageSize;
  return delta;
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

export interface GraphController {
  meta: Meta | null;
  projects: ProjectOption[];
  selectedProjectId: string;
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  selectedId: string;
  graph: GraphSlice | null;
  details: NodeDetails | null;
  loading: boolean;
  searching: boolean;
  errorMessage: string;
  setErrorMessage: (message: string) => void;
  graphError: string;
  depth: number;
  setDepth: (depth: number) => void;
  limit: number;
  setLimit: (limit: number) => void;
  groupBy: GroupBy;
  setGroupBy: (groupBy: GroupBy) => void;
  selectedEdgeKinds: string[];
  setSelectedEdgeKinds: (kinds: string[]) => void;
  activeEdgeKinds: string[];
  areAllEdgeKindsSelected: boolean;
  zoomPercent: number;
  graphTransformStyle: CSSProperties;
  isPanning: boolean;
  graphViewportRef: RefObject<HTMLDivElement | null>;
  graphHostRef: RefObject<HTMLDivElement | null>;
  graphSummary: string;
  selectedSummary: string;
  displayPath: (path: string) => string;
  runSearch: () => Promise<void>;
  selectSearchResult: (result: SearchResult) => void;
  selectRelation: (relation: Relation) => void;
  selectNode: (nodeId: string) => void;
  switchProject: (projectId: string) => Promise<void>;
  zoomIn: () => void;
  zoomOut: () => void;
  fitGraph: () => void;
  resetGraphView: () => void;
  closeGraphView: () => void;
  handleGraphPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleGraphPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  endGraphPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function useGraphController(enabled = true): GraphController {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [graph, setGraph] = useState<GraphSlice | null>(null);
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [graphError, setGraphError] = useState('');
  const [depth, setDepth] = useState(1);
  const [limit, setLimit] = useState(36);
  const [groupBy, setGroupBy] = useState<GroupBy>('directory');
  const [selectedEdgeKinds, setSelectedEdgeKinds] = useState<string[]>([]);
  const [zoom, setZoomState] = useState(1);
  const [panX, setPanX] = useState(24);
  const [panY, setPanY] = useState(24);
  const [isPanning, setIsPanning] = useState(false);
  const graphViewportRef = useRef<HTMLDivElement>(null);
  const graphHostRef = useRef<HTMLDivElement>(null);
  const loadSequence = useRef(0);
  const panState = useRef<PanState | null>(null);
  const restoringState = useRef(true);

  const displayPath = useCallback((value: string): string => {
    if (!meta) return value;
    const root = `${meta.projectRoot}/`;
    return value.startsWith(root) ? value.slice(root.length) : value;
  }, [meta]);

  const resetGraphView = useCallback(() => {
    setZoomState(1);
    setPanX(24);
    setPanY(24);
  }, []);

  const resetProjectView = useCallback(() => {
    setQuery('');
    setResults([]);
    setSelectedId('');
    setGraph(null);
    setDetails(null);
    setGraphError('');
    setErrorMessage('');
    resetGraphView();
  }, [resetGraphView]);

  const loadMeta = useCallback(async (projectId: string): Promise<Meta | null> => {
    try {
      const nextMeta = await fetchJson<Meta>(withProject('/api/meta', projectId));
      setMeta(nextMeta);
      setSelectedProjectId(nextMeta.projectId);
      const preferred = nextMeta.edgeKinds.filter((kind) => preferredEdges.has(kind));
      setSelectedEdgeKinds(preferred.length > 0 ? preferred : [...nextMeta.edgeKinds]);
      return nextMeta;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const savedState = readViewerState();
      let nextProjects: ProjectOption[] = [];
      try {
        nextProjects = await fetchJson<ProjectOption[]>('/api/projects');
        if (!cancelled) setProjects(nextProjects);
      } catch {
        // Standalone viewer servers may expose only their primary project.
      }
      if (cancelled) return;
      const savedProject = savedState?.projectId
        ? nextProjects.find((project) => project.id === savedState.projectId)
        : undefined;
      const projectId = savedProject?.id ?? nextProjects[0]?.id ?? '';
      const loadedMeta = await loadMeta(projectId);
      if (cancelled || !loadedMeta) return;
      if (savedState && (!savedState.projectId || savedState.projectId === loadedMeta.projectId)) {
        setDepth(Math.min(4, Math.max(0, Math.round(savedState.depth))));
        setLimit(Math.min(120, Math.max(12, Math.round(savedState.limit / 12) * 12)));
        setGroupBy(savedState.groupBy);
        const availableEdges = new Set(loadedMeta.edgeKinds);
        const restoredEdges = savedState.edgeKinds.filter((kind) => availableEdges.has(kind));
        if (restoredEdges.length > 0) setSelectedEdgeKinds(restoredEdges);
        setQuery(savedState.query);
        setSelectedId(savedState.selectedId);
        setZoomState(clampZoom(savedState.zoom));
        setPanX(savedState.panX);
        setPanY(savedState.panY);
        if (savedState.query) {
          try {
            const found = await fetchJson<SearchResult[]>(withProject(
              `/api/search?q=${encodeURIComponent(savedState.query)}&limit=24`,
              loadedMeta.projectId,
            ));
            if (!cancelled) setResults(found);
          } catch {
            // Restoring search results is optional; the query remains available.
          }
        }
      }
      restoringState.current = false;
    };
    void load();
    return () => { cancelled = true; };
  }, [enabled, loadMeta]);

  useEffect(() => {
    if (!enabled || !selectedId || !selectedProjectId) return;
    const sequence = ++loadSequence.current;
    const load = async (): Promise<void> => {
      setLoading(true);
      setGraphError('');
      const params = new URLSearchParams({
        root: selectedId,
        depth: String(depth),
        limit: String(limit),
        groupBy,
        edgeKinds: selectedEdgeKinds.join(','),
      });
      try {
        const [nextGraph, nextDetails] = await Promise.all([
          fetchJson<GraphSlice>(withProject(`/api/graph?${params.toString()}`, selectedProjectId)),
          fetchJson<NodeDetails>(withProject(`/api/node?id=${encodeURIComponent(selectedId)}`, selectedProjectId)),
        ]);
        if (sequence !== loadSequence.current) return;
        setGraph(nextGraph);
        setDetails(nextDetails);
      } catch (error) {
        if (sequence === loadSequence.current) {
          setGraphError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (sequence === loadSequence.current) setLoading(false);
      }
    };
    void load();
  }, [depth, enabled, groupBy, limit, selectedEdgeKinds, selectedId, selectedProjectId]);

  useEffect(() => {
    if (!enabled || restoringState.current) return;
    const snapshot: ViewerStateSnapshot = {
      projectId: selectedProjectId || meta?.projectId || '',
      query,
      selectedId,
      depth,
      limit,
      groupBy,
      edgeKinds: [...selectedEdgeKinds],
      zoom,
      panX,
      panY,
    };
    try {
      window.localStorage.setItem(VIEWER_STATE_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Persistence is optional when storage is unavailable.
    }
  }, [depth, enabled, groupBy, limit, meta?.projectId, panX, panY, query, selectedEdgeKinds, selectedId, selectedProjectId, zoom]);

  const fitGraph = useCallback(() => {
    const viewport = graphViewportRef.current;
    const svg = graphHostRef.current?.querySelector<SVGSVGElement>('svg');
    if (!viewport || !svg) {
      resetGraphView();
      return;
    }
    const viewBox = svg.viewBox.baseVal;
    const width = viewBox.width || Number.parseFloat(svg.getAttribute('width') ?? '0');
    const height = viewBox.height || Number.parseFloat(svg.getAttribute('height') ?? '0');
    if (!width || !height) {
      resetGraphView();
      return;
    }
    const availableWidth = Math.max(viewport.clientWidth - 48, 1);
    const availableHeight = Math.max(viewport.clientHeight - 48, 1);
    const nextZoom = clampZoom(Math.min(availableWidth / width, availableHeight / height));
    setZoomState(nextZoom);
    setPanX(Math.max(24, (viewport.clientWidth - width * nextZoom) / 2));
    setPanY(Math.max(24, (viewport.clientHeight - height * nextZoom) / 2));
  }, [resetGraphView]);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return undefined;
    const frame = requestAnimationFrame(fitGraph);
    return () => cancelAnimationFrame(frame);
  }, [fitGraph, graph]);

  const setZoom = useCallback((nextZoom: number, anchor?: { clientX: number; clientY: number }): void => {
    const clampedZoom = clampZoom(nextZoom);
    if (clampedZoom === zoom) return;
    if (anchor && graphViewportRef.current) {
      const bounds = graphViewportRef.current.getBoundingClientRect();
      const localX = anchor.clientX - bounds.left;
      const localY = anchor.clientY - bounds.top;
      const graphX = (localX - panX) / zoom;
      const graphY = (localY - panY) / zoom;
      setPanX(localX - graphX * clampedZoom);
      setPanY(localY - graphY * clampedZoom);
    }
    setZoomState(clampedZoom);
  }, [panX, panY, zoom]);

  const zoomAroundViewport = useCallback((factor: number): void => {
    const viewport = graphViewportRef.current;
    if (!viewport) {
      setZoom(zoom * factor);
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    setZoom(zoom * factor, {
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    });
  }, [setZoom, zoom]);

  const runSearch = useCallback(async (): Promise<void> => {
    const search = query.trim();
    if (!search) {
      setResults([]);
      return;
    }
    setSearching(true);
    setErrorMessage('');
    try {
      setResults(await fetchJson<SearchResult[]>(withProject(
        `/api/search?q=${encodeURIComponent(search)}&limit=24`,
        selectedProjectId,
      )));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSearching(false);
    }
  }, [query, selectedProjectId]);

  const switchProject = useCallback(async (projectId: string): Promise<void> => {
    if (!projectId || projectId === meta?.projectId) return;
    loadSequence.current += 1;
    setSelectedProjectId(projectId);
    resetProjectView();
    await loadMeta(projectId);
  }, [loadMeta, meta?.projectId, resetProjectView]);

  const closeGraphView = useCallback(() => {
    loadSequence.current += 1;
    setSelectedId('');
    setGraph(null);
    setDetails(null);
    setLoading(false);
    setGraphError('');
    resetGraphView();
  }, [resetGraphView]);

  const handleGraphPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.codegraph-node')) return;
    panState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: panX,
      originY: panY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
    event.preventDefault();
  }, [panX, panY]);

  const handleGraphPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = panState.current;
    if (!state || event.pointerId !== state.pointerId) return;
    setPanX(state.originX + event.clientX - state.startX);
    setPanY(state.originY + event.clientY - state.startY);
  }, []);

  const endGraphPan = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!panState.current || event.pointerId !== panState.current.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    panState.current = null;
    setIsPanning(false);
  }, []);

  const handleGraphWheel = useCallback((event: WheelEvent): void => {
    event.preventDefault();
    const viewport = graphViewportRef.current;
    const pageSize = viewport?.clientHeight ?? window.innerHeight;
    const deltaX = wheelDeltaInPixels(event.deltaX, event.deltaMode, pageSize);
    const deltaY = wheelDeltaInPixels(event.deltaY, event.deltaMode, pageSize);

    if (event.ctrlKey || event.metaKey) {
      setZoom(zoom * Math.exp(-deltaY * TRACKPAD_ZOOM_SENSITIVITY), {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      return;
    }

    const shiftToHorizontal = event.shiftKey && Math.abs(deltaX) < Math.abs(deltaY);
    setPanX((currentPanX) => currentPanX - (shiftToHorizontal ? deltaY : deltaX));
    if (!shiftToHorizontal) setPanY((currentPanY) => currentPanY - deltaY);
  }, [setZoom, zoom]);

  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (!enabled || !graph || !viewport) return undefined;

    viewport.addEventListener('wheel', handleGraphWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleGraphWheel);
  }, [enabled, graph, handleGraphWheel]);

  return {
    meta,
    projects,
    selectedProjectId,
    query,
    setQuery,
    results,
    selectedId,
    graph,
    details,
    loading,
    searching,
    errorMessage,
    setErrorMessage,
    graphError,
    depth,
    setDepth,
    limit,
    setLimit,
    groupBy,
    setGroupBy,
    selectedEdgeKinds,
    setSelectedEdgeKinds,
    activeEdgeKinds: meta?.edgeKinds ?? [],
    areAllEdgeKindsSelected: Boolean(meta?.edgeKinds.length)
      && (meta?.edgeKinds.every((kind) => selectedEdgeKinds.includes(kind)) ?? false),
    zoomPercent: Math.round(zoom * 100),
    graphTransformStyle: { transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})` },
    isPanning,
    graphViewportRef,
    graphHostRef,
    graphSummary: graph
      ? `${graph.nodes.length} nodes · ${graph.edges.length} relations`
      : 'Choose a symbol from the search results.',
    selectedSummary: details
      ? `${details.node.kind} · ${details.node.filePath}:${details.node.startLine}`
      : 'Select a node to view its source and relationships.',
    displayPath,
    runSearch,
    selectSearchResult: (result) => setSelectedId(result.id),
    selectRelation: (relation) => setSelectedId(relation.id),
    selectNode: setSelectedId,
    switchProject,
    zoomIn: () => zoomAroundViewport(1.25),
    zoomOut: () => zoomAroundViewport(0.8),
    fitGraph,
    resetGraphView,
    closeGraphView,
    handleGraphPointerDown,
    handleGraphPointerMove,
    endGraphPan,
  };
}
