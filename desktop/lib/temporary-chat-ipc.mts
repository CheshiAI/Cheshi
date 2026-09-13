import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { chatAttachmentKind } from './chat-attachment-store.mts';
import type { TemporaryChatService } from './temporary-chat-service.mts';
import { TemporaryChatClosedError, type TemporaryChatReply } from '../shared/temporary-chat.ts';

type TemporaryService = Pick<TemporaryChatService, 'models' | 'send' | 'close'>;
interface TemporaryChatIpcOptions {
  ipc: Pick<IpcMain, 'handle'>;
  createService(): TemporaryService;
  assertSender(event: IpcMainInvokeEvent): void;
  selectFiles(event: IpcMainInvokeEvent): Promise<string[]>;
  onCleanupError(error: unknown): void;
}

interface Session {
  id: string;
  service: TemporaryService;
}

async function temporaryReply<T>(operation: () => Promise<T>): Promise<TemporaryChatReply<T>> {
  try {
    return { status: 'ok', value: await operation() };
  } catch (error) {
    if (error instanceof TemporaryChatClosedError) return { status: 'closed' };
    throw error;
  }
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Invalid temporary chat session id.');
  }
  return value;
}

/** Each renderer owns at most one disposable conversation and its process. */
export function registerTemporaryChatIpc(options: TemporaryChatIpcOptions) {
  const sessions = new Map<WebContents, Session>();
  const owners = new Map<WebContents, () => void>();
  const closing = new Set<Promise<void>>();
  let stopped = false;

  const closeService = (service: TemporaryService): Promise<void> => {
    const flight = Promise.resolve().then(() => service.close());
    closing.add(flight);
    void flight.finally(() => closing.delete(flight)).catch(options.onCleanupError);
    return flight;
  };
  const closeOwner = (owner: WebContents): Promise<void> => {
    const session = sessions.get(owner);
    sessions.delete(owner);
    return session ? closeService(session.service) : Promise.resolve();
  };
  const watchOwner = (owner: WebContents) => {
    if (owners.has(owner)) return;
    const cleanup = () => { void closeOwner(owner).catch(() => undefined); };
    const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame === true && details.isSameDocument === false) cleanup();
    };
    const destroyed = () => {
      cleanup();
      owners.get(owner)?.();
      owners.delete(owner);
    };
    owner.on('did-start-navigation', navigate);
    owner.on('render-process-gone', cleanup);
    owner.once('destroyed', destroyed);
    owners.set(owner, () => {
      owner.off('did-start-navigation', navigate);
      owner.off('render-process-gone', cleanup);
      owner.off('destroyed', destroyed);
    });
  };
  const selected = (event: IpcMainInvokeEvent, value: unknown, create = false): Session => {
    options.assertSender(event);
    const id = sessionId(value);
    if (stopped) throw new Error('Temporary chat is unavailable.');
    let session = sessions.get(event.sender);
    if (!session && create) {
      watchOwner(event.sender);
      session = { id, service: options.createService() };
      sessions.set(event.sender, session);
    }
    if (!session || session.id !== id) throw new Error('Temporary chat is closed. Reopen it to start again.');
    return session;
  };

  options.ipc.handle('cheshi:temporary-chat-models', (event, id) => {
    const session = selected(event, id, true);
    return temporaryReply(() => session.service.models());
  });
  options.ipc.handle('cheshi:temporary-chat-send', (event, id, request) => {
    const session = selected(event, id);
    return temporaryReply(() => session.service.send(request));
  });
  options.ipc.handle('cheshi:temporary-chat-attachments', (event, id) => {
    const session = selected(event, id);
    return temporaryReply(async () => {
      const paths = [...new Set(await options.selectFiles(event))].slice(0, 20);
      const attachments = await Promise.all(paths.map(async (filePath) => {
        if (!path.isAbsolute(filePath) || !(await stat(filePath)).isFile()) {
          throw new TypeError('Select a regular file to attach.');
        }
        return { kind: chatAttachmentKind(filePath), name: path.basename(filePath), path: filePath };
      }));
      if (sessions.get(event.sender) !== session) throw new TemporaryChatClosedError();
      return attachments;
    });
  });
  options.ipc.handle('cheshi:temporary-chat-close', (event, value) => {
    options.assertSender(event);
    const id = sessionId(value);
    if (sessions.get(event.sender)?.id !== id) return;
    return closeOwner(event.sender);
  });

  return {
    get hasSessions(): boolean { return sessions.size > 0 || closing.size > 0; },
    async stop(): Promise<void> {
      stopped = true;
      for (const remove of owners.values()) remove();
      owners.clear();
      const operations = [...sessions.keys()].map(closeOwner);
      const results = await Promise.allSettled([...operations, ...closing]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
