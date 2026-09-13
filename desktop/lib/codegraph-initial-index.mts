import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CodeGraphIndexer } from './codegraph-service.mts';

interface InitialIndexOptions {
  databasePath: string;
  workspaceRoot: string;
  dataRoot: string;
  command: ConstructorParameters<typeof CodeGraphIndexer>[0]['command'];
  signal: AbortSignal;
  onIndexing?: () => void;
}
type Indexer = Pick<CodeGraphIndexer, 'initialize' | 'reindex' | 'stop'>;
interface IndexJob {
  ready: Promise<void>;
  indexer: Indexer;
  consumers: number;
  cancelled: boolean;
}

function pendingPath(databasePath: string): string { return `${databasePath}.initializing`; }

export function hasReadyCodeGraphIndex(databasePath: string): boolean {
  return existsSync(databasePath) && !existsSync(pendingPath(databasePath));
}

/** Shares first-time writers across windows; readers wait until the writer exits. */
export class InitialCodeGraphIndexes {
  private readonly jobs = new Map<string, IndexJob>();
  private readonly createIndexer: (options: InitialIndexOptions) => Indexer;

  constructor(createIndexer: (options: InitialIndexOptions) => Indexer = (options) => new CodeGraphIndexer({ command: options.command })) {
    this.createIndexer = createIndexer;
  }

  async ensure(options: InitialIndexOptions): Promise<void> {
    options.signal.throwIfAborted();
    const key = path.resolve(options.databasePath);
    let job = this.jobs.get(key);
    if (job?.cancelled) {
      await job.ready.catch(() => undefined);
      return this.ensure(options);
    }
    if (!job && hasReadyCodeGraphIndex(key)) return;
    options.onIndexing?.();
    if (!job) {
      const indexer = this.createIndexer(options);
      job = { ready: Promise.resolve(), indexer, consumers: 0, cancelled: false };
      const created = job;
      this.jobs.set(key, job);
      job.ready = Promise.resolve().then(async () => {
        if (created.cancelled) throw new Error('Initial indexing was cancelled.');
        if (hasReadyCodeGraphIndex(key)) return;
        const databaseExists = existsSync(key);
        mkdirSync(path.dirname(key), { recursive: true });
        // Retain this marker on failure so a partial database is never served.
        writeFileSync(pendingPath(key), 'Initial CodeGraph indexing is incomplete.\n');
        if (databaseExists) await indexer.reindex(options.workspaceRoot, options.dataRoot);
        else await indexer.initialize(options.workspaceRoot, options.dataRoot);
        if (created.cancelled) throw new Error('Initial indexing was cancelled.');
        assertDatabaseCreated(key);
        unlinkSync(pendingPath(key));
      }).finally(() => {
        if (this.jobs.get(key) === created) this.jobs.delete(key);
      });
    }
    await this.join(job, options.signal);
  }

  private async join(job: IndexJob, signal: AbortSignal): Promise<void> {
    job.consumers += 1;
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      await Promise.race([job.ready, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      job.consumers -= 1;
      if (signal.aborted && job.consumers === 0) {
        job.cancelled = true;
        await job.indexer.stop();
      }
    }
  }
}

function assertDatabaseCreated(databasePath: string): void {
  if (!existsSync(databasePath)) throw new Error('CodeGraph initialization did not create an index.');
}

const initialIndexes = new InitialCodeGraphIndexes();

export async function prepareInitialCodeGraph(options: InitialIndexOptions): Promise<{ ready: boolean; error: string | null }> {
  try {
    await initialIndexes.ensure(options);
    return { ready: true, error: null };
  } catch (error) {
    options.signal.throwIfAborted();
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}
