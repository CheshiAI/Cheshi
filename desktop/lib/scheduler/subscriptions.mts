import type { WebContents } from 'electron';
import { SCHEDULER_CHANGED_CHANNEL } from '../../shared/scheduler.ts';

export function createSchedulerSubscriptions() {
  const clients = new Map<WebContents, { tokens: Set<string>; dispose(): void }>();
  const remove = (sender: WebContents) => { clients.get(sender)?.dispose(); clients.delete(sender); };
  return {
    add(sender: WebContents, token: string) {
      if (sender.isDestroyed()) return;
      if (!clients.has(sender)) {
        const destroyed = () => remove(sender);
        const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
          if (mainFrame && !inPlace) remove(sender);
        };
        sender.once('destroyed', destroyed);
        sender.on('did-start-navigation', navigated);
        clients.set(sender, { tokens: new Set(), dispose() {
          sender.removeListener('destroyed', destroyed); sender.removeListener('did-start-navigation', navigated);
        } });
      }
      clients.get(sender)!.tokens.add(token);
    },
    remove(sender: WebContents, token: string) {
      const client = clients.get(sender);
      client?.tokens.delete(token);
      if (!client?.tokens.size) remove(sender);
    },
    changed() {
      for (const sender of clients.keys()) {
        if (sender.isDestroyed()) { remove(sender); continue; }
        sender.send(SCHEDULER_CHANGED_CHANNEL);
      }
    },
    dispose() { for (const sender of clients.keys()) remove(sender); },
  };
}
