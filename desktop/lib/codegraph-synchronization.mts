import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';
import { CodeGraphIndexer } from './codegraph-service.mts';

export interface CodeGraphSyncConnection { url: string; token: string; workspaceRoot: string; }
export interface CodeGraphSynchronization {
  ensure(workspace: string, signal?: AbortSignal): Promise<void>;
  connection(workspace: string): Promise<CodeGraphSyncConnection>;
  exclusive<T>(workspace: string, operation: () => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

async function joinSynchronization(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let cancel = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

/** One writer per canonical workspace, shared by SESSION, Homies, and manual reindexing. */
export function createCodeGraphSynchronization(options: {
  command: ConstructorParameters<typeof CodeGraphIndexer>[0]['command'];
  dataRoot: string;
  createIndexer?: () => Pick<CodeGraphIndexer, 'synchronize' | 'stop'>;
}): CodeGraphSynchronization {
  if (!path.isAbsolute(options.dataRoot)) throw new Error('An absolute CodeGraph data root is required.');
  const tails = new Map<string, Promise<unknown>>();
  const syncs = new Map<string, Promise<void>>();
  const writers = new Set<Pick<CodeGraphIndexer, 'synchronize' | 'stop'>>();
  const routes = new Map<string, string>();
  const token = randomBytes(32).toString('hex');
  let closed = false;
  let server: Server | undefined;
  let listening: Promise<string> | undefined;
  const assertOpen = () => { if (closed) throw new Error('CodeGraph synchronization is stopped.'); };
  const enqueue = <T,>(root: string, operation: () => Promise<T>): Promise<T> => {
    assertOpen();
    const pending = (tails.get(root) ?? Promise.resolve()).catch(() => {}).then(() => { assertOpen(); return operation(); });
    tails.set(root, pending);
    void pending.finally(() => { if (tails.get(root) === pending) tails.delete(root); }).catch(() => {});
    return pending;
  };
  const ensure = async (workspace: string): Promise<void> => {
    const root = realpathSync.native(workspace);
    assertOpen();
    const existing = syncs.get(root);
    if (existing && tails.get(root) === existing) return existing;
    const pending = enqueue(root, async () => {
      const database = path.join(codeGraphStorageDirectory(options.dataRoot, root), 'codegraph.db');
      if (existsSync(`${database}.initializing`)) throw new Error('CodeGraph initialization is incomplete. Reopen the workspace to retry.');
      // Automatic freshness never creates an index or repairs a lock.
      if (!existsSync(database)) return;
      const writer = options.createIndexer?.() ?? new CodeGraphIndexer({ command: options.command });
      writers.add(writer);
      try { await writer.synchronize(root, options.dataRoot); }
      finally { writers.delete(writer); }
    });
    syncs.set(root, pending);
    try { await pending; }
    finally { if (syncs.get(root) === pending) syncs.delete(root); }
  };
  const listen = (): Promise<string> => {
    assertOpen();
    if (listening) return listening;
    server = createServer((request, response) => {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      const root = routes.get(request.url ?? '');
      if (request.method !== 'POST' || request.headers.origin || !root || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(403).end(); request.resume(); return;
      }
      request.resume();
      void ensure(root).then(() => response.writeHead(204).end(), () => {
        response.writeHead(503, { 'Content-Type': 'text/plain' }).end('CodeGraph synchronization failed. Use source files until synchronization succeeds.');
      });
    });
    const current = server;
    listening = new Promise<string>((resolve, reject) => {
      current.once('error', reject);
      current.listen(0, '127.0.0.1', () => {
        const address = current.address();
        if (!address || typeof address === 'string') { reject(new Error('CodeGraph synchronization address is unavailable.')); return; }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    void listening.catch(() => { listening = undefined; current.close(); });
    return listening;
  };
  return {
    ensure: (workspace, signal) => joinSynchronization(() => ensure(workspace), signal),
    exclusive: async (workspace, operation) => enqueue(realpathSync.native(workspace), operation),
    connection: async workspace => {
      const root = realpathSync.native(workspace);
      const origin = await listen();
      assertOpen();
      let route = [...routes].find(([, value]) => value === root)?.[0];
      if (!route) { route = `/sync/${randomBytes(24).toString('hex')}`; routes.set(route, root); }
      return { url: `${origin}${route}`, token, workspaceRoot: root };
    },
    dispose: async () => {
      closed = true;
      await Promise.all([...writers].map(writer => writer.stop()));
      await Promise.allSettled([...tails.values()]);
      await listening?.catch(() => {});
      if (server?.listening) {
        const current = server;
        await new Promise<void>(resolve => { current.close(() => resolve()); current.closeAllConnections(); });
      }
      routes.clear();
    },
  };
}
