import { CodexChatService } from './codex-chat-service.mts';
import type { CodexChatClient, JsonObject } from './codex-chat-types.mts';

type ContextClient = CodexChatClient & { stop(): Promise<void> };
type ServiceOptions = Omit<ConstructorParameters<typeof CodexChatService>[0], 'client'>;
type ChatContext = { service: CodexChatService; client: ContextClient };

export function chatContextId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Chat context id must contain 1 to 128 letters, digits, underscores, or hyphens.');
  }
  return value;
}

function contextClient(client: ContextClient): ContextClient {
  let disposed = false;
  const assertOpen = () => {
    if (disposed) throw new Error('This chat pane has been closed.');
  };
  return {
    request: async (method, params, timeoutMs) => {
      assertOpen();
      const result = await client.request(method, params, timeoutMs);
      assertOpen();
      return result;
    },
    respond: async (id, result) => { assertOpen(); await client.respond(id, result); },
    onNotification: (listener) => client.onNotification(listener),
    onRequest: (listener) => client.onRequest(listener),
    onDidFail: (listener) => client.onDidFail(listener),
    stop: async () => { disposed = true; await client.stop(); },
  };
}

/** Each pane owns its transport as well as its mutable session and approval state. */
export class CodexChatContexts {
  private readonly owners = new Map<number, Map<string, ChatContext>>();
  private readonly disposalListeners = new Set<(ownerId: number, contextId?: string) => void>();
  private readonly closedContexts = new Map<number, Set<string>>();

  private readonly options: {
    createClient(): ContextClient;
    service: ServiceOptions;
    emit(ownerId: number, event: JsonObject): void;
  };

  constructor(options: CodexChatContexts['options']) {
    this.options = options;
  }

  get(ownerId: number, value: unknown): CodexChatService {
    const contextId = chatContextId(value);
    if (this.closedContexts.get(ownerId)?.has(contextId)) throw new Error('This chat pane has been closed.');
    let contexts = this.owners.get(ownerId);
    const existing = contexts?.get(contextId);
    if (existing) return existing.service;
    if ((contexts?.size ?? 0) >= 32) throw new Error('Too many chat panes are open.');
    if (!contexts) {
      contexts = new Map();
      this.owners.set(ownerId, contexts);
    }
    const client = contextClient(this.options.createClient());
    const service = new CodexChatService({ ...this.options.service, client });
    contexts.set(contextId, { service, client });
    service.onEvent((event) => {
      if (contexts.get(contextId)?.service !== service) return;
      this.options.emit(ownerId, { ...event, contextId });
      if (event.type === 'session-created' || event.type === 'sessions-changed') {
        for (const [otherId] of contexts) {
          if (otherId !== contextId) this.options.emit(ownerId, { type: 'sessions-changed', contextId: otherId });
        }
      }
    });
    return service;
  }

  existing(ownerId: number, contextId: string): CodexChatService | null {
    return this.owners.get(ownerId)?.get(contextId)?.service ?? null;
  }

  allServices(): Array<{ ownerId: number; contextId: string; service: CodexChatService }> {
    return [...this.owners].flatMap(([ownerId, contexts]) => [...contexts].map(([contextId, { service }]) => ({ ownerId, contextId, service })));
  }

  onDispose(listener: (ownerId: number, contextId?: string) => void): () => void {
    this.disposalListeners.add(listener);
    return () => { this.disposalListeners.delete(listener); };
  }

  async dispose(ownerId: number, value: unknown): Promise<void> {
    const contextId = chatContextId(value);
    for (const listener of this.disposalListeners) listener(ownerId, contextId);
    let closed = this.closedContexts.get(ownerId);
    if (!closed) {
      closed = new Set();
      this.closedContexts.set(ownerId, closed);
    }
    closed.add(contextId);
    const contexts = this.owners.get(ownerId);
    const context = contexts?.get(contextId);
    if (!contexts || !context) return;
    contexts.delete(contextId);
    if (contexts.size === 0) this.owners.delete(ownerId);
    await Promise.all([context.service.stop(), context.client.stop()]);
  }

  async disposeOwner(ownerId: number): Promise<void> {
    for (const listener of this.disposalListeners) listener(ownerId);
    const contexts = this.owners.get(ownerId);
    this.owners.delete(ownerId);
    this.closedContexts.delete(ownerId);
    if (!contexts) return;
    const detached = [...contexts.values()];
    contexts.clear();
    await Promise.all(detached.map(async ({ service, client }) => {
      await Promise.all([service.stop(), client.stop()]);
    }));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.owners.keys()].map((id) => this.disposeOwner(id)));
    this.closedContexts.clear();
  }
}
