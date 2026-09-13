import type {
  LocalHistoryEntry,
  LocalHistoryRestoreRequest,
  LocalHistorySnapshot,
} from '../../../../shared/local-history';
import type { WorkspaceFileReadResult, WorkspaceFileWriteResult } from '../../cheshiDesktop';

interface LocalHistoryClient {
  localHistory: {
    list(path: string): Promise<LocalHistoryEntry[]>;
    read(path: string, id: string): Promise<LocalHistorySnapshot>;
    restore(request: LocalHistoryRestoreRequest): Promise<WorkspaceFileWriteResult>;
  };
  readWorkspaceFile(path: string): Promise<WorkspaceFileReadResult>;
}

export interface LocalHistoryState {
  entries: LocalHistoryEntry[];
  selectedId: string | null;
  snapshot: LocalHistorySnapshot | null;
  current: WorkspaceFileReadResult | null;
  loading: boolean;
  loadingSnapshot: boolean;
  restoring: boolean;
  error: string | null;
  notice: string | null;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class LocalHistoryModel {
  private readonly api: LocalHistoryClient | undefined;
  private readonly path: string;
  private readonly listeners = new Set<() => void>();
  private request = 0;
  private selectionRequest = 0;
  private disposed = false;
  private state: LocalHistoryState = {
    entries: [], selectedId: null, snapshot: null, current: null,
    loading: true, loadingSnapshot: false, restoring: false, error: null, notice: null,
  };

  constructor(path: string, api: LocalHistoryClient | undefined) {
    this.path = path;
    this.api = api;
  }

  getSnapshot = (): LocalHistoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start(): void {
    this.disposed = false;
    void this.refresh();
  }

  private update(patch: Partial<LocalHistoryState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  dispose(): void {
    this.disposed = true;
    this.request += 1;
    this.selectionRequest += 1;
    this.listeners.clear();
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.state.restoring) return;
    if (!this.api) {
      this.update({ loading: false, error: 'Local history is unavailable in this window.' });
      return;
    }
    const request = ++this.request;
    this.selectionRequest += 1;
    this.update({ loading: true, loadingSnapshot: false, error: null });
    // Reading a previously unopened file records its baseline before listing versions.
    const [currentResult] = await Promise.allSettled([this.api.readWorkspaceFile(this.path)]);
    if (this.disposed || request !== this.request) return;
    const [entriesResult] = await Promise.allSettled([this.api.localHistory.list(this.path)]);
    if (this.disposed || request !== this.request) return;
    if (entriesResult.status === 'rejected') {
      this.update({ loading: false, current: null, error: errorMessage(entriesResult.reason) });
      return;
    }
    const entries = entriesResult.value;
    const current = currentResult.status === 'fulfilled' ? currentResult.value : null;
    const selectedId = entries.some((entry) => entry.id === this.state.selectedId)
      ? this.state.selectedId : entries[0]?.id ?? null;
    this.update({
      entries, current, selectedId, loading: false,
      error: currentResult.status === 'rejected'
        ? `Could not read the current file: ${errorMessage(currentResult.reason)}`
        : current?.file.fileKind !== 'text' ? 'Only text files can be compared and restored.' : null,
    });
    if (selectedId) await this.select(selectedId);
    else this.update({ snapshot: null });
  }

  async select(id: string): Promise<void> {
    if (!this.api || this.disposed || this.state.restoring || this.state.loading
      || !this.state.entries.some((entry) => entry.id === id)) return;
    const request = ++this.selectionRequest;
    this.update({
      selectedId: id, snapshot: null, loadingSnapshot: true, notice: null,
      ...(this.state.current?.file.fileKind === 'text' ? { error: null } : {}),
    });
    try {
      const snapshot = await this.api.localHistory.read(this.path, id);
      if (this.disposed || request !== this.selectionRequest) return;
      this.update({ snapshot, loadingSnapshot: false });
    } catch (error) {
      if (this.disposed || request !== this.selectionRequest) return;
      this.update({ loadingSnapshot: false, error: errorMessage(error) });
    }
  }

  async restore(draftDirty: boolean): Promise<WorkspaceFileWriteResult | null> {
    const { snapshot, current, loading, loadingSnapshot, restoring } = this.state;
    if (!this.api || this.disposed || draftDirty || loading || loadingSnapshot || restoring
      || !snapshot || current?.file.fileKind !== 'text' || current.content === null) return null;
    this.update({ restoring: true, error: null, notice: null });
    let result: WorkspaceFileWriteResult;
    try {
      result = await this.api.localHistory.restore({
        path: this.path, id: snapshot.entry.id, expectedRevision: current.file.revision,
      });
    } catch (error) {
      this.update({ restoring: false, error: errorMessage(error) });
      return null;
    }
    this.update({ restoring: false });
    await this.refresh();
    this.update(result.status === 'conflict'
      ? { error: 'The file changed since this comparison. Review the refreshed contents before restoring.' }
      : { notice: 'Version restored. The previous file contents are kept in local history.' });
    return this.disposed ? null : result;
  }
}
