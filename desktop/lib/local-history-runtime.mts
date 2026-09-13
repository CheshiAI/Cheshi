import path from 'node:path';
import { LocalHistoryService, type LocalHistoryServiceOptions } from './local-history-service.mts';

type HistoryLease = Pick<LocalHistoryService,
  'readFile' | 'writeFile' | 'writeFiles' | 'list' | 'read' | 'restore' | 'captureChanged' | 'dispose'>;
interface HistoryOwner { ready: Promise<LocalHistoryService>; references: number; }
const owners = new Map<string, HistoryOwner>();
const closing = new Map<string, Promise<void>>();

/** All windows for one workspace share a writer; reopening waits for the previous writer to drain. */
export function acquireLocalHistory(options: LocalHistoryServiceOptions): HistoryLease {
  const key = path.resolve(options.directory);
  let owner = owners.get(key);
  if (!owner) {
    const pendingClose = closing.get(key) ?? Promise.resolve();
    owner = { ready: pendingClose.then(() => new LocalHistoryService(options)), references: 0 };
    owners.set(key, owner);
  }
  owner.references += 1;
  const currentOwner = owner;
  let released = false;
  let disposal: Promise<void> | null = null;
  const run = <T,>(operation: (service: LocalHistoryService) => Promise<T>): Promise<T> => {
    if (released) return Promise.reject(new Error('Local history has been closed.'));
    return currentOwner.ready.then(operation);
  };
  return {
    readFile: filePath => run(service => service.readFile(filePath)),
    writeFile: request => run(service => service.writeFile(request)),
    writeFiles: request => run(service => service.writeFiles(request)),
    list: filePath => run(service => service.list(filePath)),
    read: (filePath, id) => run(service => service.read(filePath, id)),
    restore: request => run(service => service.restore(request)),
    captureChanged: event => released ? Promise.resolve() : run(service => service.captureChanged(event)),
    dispose() {
      if (disposal) return disposal;
      released = true;
      currentOwner.references -= 1;
      if (currentOwner.references > 0) return disposal = Promise.resolve();
      owners.delete(key);
      disposal = currentOwner.ready.then(service => service.dispose());
      closing.set(key, disposal);
      const completed = disposal;
      void completed.then(() => {
        if (closing.get(key) === completed) closing.delete(key);
      }, () => {
        if (closing.get(key) === completed) closing.delete(key);
      });
      return disposal;
    },
  };
}
