import { parentPort, workerData } from 'node:worker_threads';
import { NotesSearchStore } from './apple-notes-search-store.mts';
import type { NotesWorkerRequest } from './apple-notes-search-worker-client.mts';

if (parentPort) {
  const port = parentPort;
  const store = await NotesSearchStore.open((workerData as { filename: string }).filename);
  port.on('message', ({ id, request }: { id: number; request: NotesWorkerRequest }) => {
    try {
      let result: unknown;
      switch (request.type) {
        case 'catalog': result = store.catalog(); break;
        case 'query': result = store.query(request.request); break;
        case 'put': store.put(request.folderId, request.note, request.bodyReady); break;
        case 'remove': store.remove(request.ids); break;
        case 'complete': store.complete(request.folders); break;
        case 'clear': store.clear(); break;
        case 'close': store.close(); break;
      }
      port.postMessage({ id, result });
      if (request.type === 'close') port.close();
    } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
}
