import type { GroupBy } from './types';

export const VIEWER_STATE_STORAGE_KEY = 'cheshi-codegraph-view-state';

export interface ViewerStateSnapshot {
  projectId: string;
  query: string;
  selectedId: string;
  depth: number;
  limit: number;
  groupBy: GroupBy;
  edgeKinds: string[];
  zoom: number;
  panX: number;
  panY: number;
}

function isGroupBy(value: unknown): value is GroupBy {
  return value === 'directory' || value === 'language' || value === 'kind';
}

export function readViewerState(storage: Pick<Storage, 'getItem'> = window.localStorage): ViewerStateSnapshot | null {
  try {
    const raw = storage.getItem(VIEWER_STATE_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const state = value as Partial<ViewerStateSnapshot>;
    if (
      typeof state.projectId !== 'string'
      || typeof state.query !== 'string'
      || typeof state.selectedId !== 'string'
      || !Number.isFinite(state.depth)
      || !Number.isFinite(state.limit)
      || !isGroupBy(state.groupBy)
      || !Array.isArray(state.edgeKinds)
      || !state.edgeKinds.every((kind) => typeof kind === 'string')
      || !Number.isFinite(state.zoom)
      || !Number.isFinite(state.panX)
      || !Number.isFinite(state.panY)
    ) return null;
    return {
      projectId: state.projectId,
      query: state.query,
      selectedId: state.selectedId,
      depth: state.depth ?? 1,
      limit: state.limit ?? 36,
      groupBy: state.groupBy,
      edgeKinds: state.edgeKinds,
      zoom: state.zoom ?? 1,
      panX: state.panX ?? 24,
      panY: state.panY ?? 24,
    };
  } catch {
    return null;
  }
}
