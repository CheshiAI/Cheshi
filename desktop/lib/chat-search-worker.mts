import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { ChatHistoryIndexStore } from './chat-history-index-store.mts';
import { openSearchDatabase } from './chat-search-database.mts';
import { ChatSearchIndex } from './chat-search-index.mts';
import { ChatSearchQuery } from './chat-search-query.mts';
import { compileSearchRecord } from './chat-search-source.mts';
import type { SearchWorkerRequest } from './chat-search-worker-client.mts';

if (parentPort) {
  const port = parentPort;
  const { directory, cwd, readonly } = workerData as { directory: string; cwd: string; readonly: boolean };
  const db = await openSearchDatabase(join(directory, 'search.sqlite'), cwd, readonly);
  const index = new ChatSearchIndex(db);
  const query = new ChatSearchQuery(db);
  const legacy = new ChatHistoryIndexStore(directory);
  let queue = Promise.resolve();
  port.on('message', (message: { id: number; request: SearchWorkerRequest }) => {
    queue = queue.then(async () => {
      try {
        const request = message.request;
        let result: unknown;
        switch (request.type) {
          case 'sessions': {
            const state = db.prepare("SELECT value FROM metadata WHERE key='ready'").get() as { value: string } | undefined;
            result = { sessions: index.sessions(), ready: !!state, ...(state ? JSON.parse(state.value) : {}) };
            break;
          }
          case 'seed': {
            const record = await legacy.load(request.session.sourceKey, cwd);
            result = !!record && record.thread.threadId === request.session.id && record.revision === request.session.revision;
            if (result && record) index.put(record, null);
            break;
          }
          case 'put': index.put(compileSearchRecord(request.raw, cwd, request.session, request.now), request.fingerprint); break;
          case 'remove': index.remove(request.keys); break;
          case 'ready': db.prepare("INSERT OR REPLACE INTO metadata VALUES('ready',?)").run(JSON.stringify({
            updatedAt: request.updatedAt, unavailableSessions: request.unavailableSessions,
          })); break;
          case 'query': result = query.search(request.request, request.now); break;
          case 'close': db.close(); break;
        }
        port.postMessage({ id: message.id, result });
        if (request.type === 'close') port.close();
      } catch (error) { port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
    });
  });
}
