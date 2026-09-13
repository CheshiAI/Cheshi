import { expect } from 'bun:test';

import { CodexChatService } from '../lib/codex-chat-service.mts';

type JsonObject = Record<string, unknown>;
type CodexChatClient = ConstructorParameters<typeof CodexChatService>[0]['client'];
type NotificationListener = Parameters<CodexChatClient['onNotification']>[0];
type RequestListener = Parameters<CodexChatClient['onRequest']>[0];
type FailureListener = Parameters<CodexChatClient['onDidFail']>[0];
type FakeRequest = { method: string; params: JsonObject };
type FakeResponse = { id: string | number; result: unknown };

function requestParameters(value: unknown): JsonObject {
  return value !== null && typeof value === 'object'
    ? value as JsonObject
    : {};
}

export function codexThread<T extends JsonObject = JsonObject>(id: string, overrides?: T) {
  return {
    id,
    parentThreadId: null,
    preview: 'Inspect the workspace',
    name: null,
    createdAt: 100,
    updatedAt: 110,
    recencyAt: 120,
    status: { type: 'idle' },
    turns: [],
    ...overrides ?? {} as T,
  };
}

export function createFakeCodexClient(responses: Record<string, unknown> = {}) {
  const notificationListeners = new Set<NotificationListener>();
  const requestListeners = new Set<RequestListener>();
  const requests: FakeRequest[] = [];
  const responsesSent: FakeResponse[] = [];

  function subscribeToNotifications(listener: NotificationListener) {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  }

  function subscribeToFailures(listener: FailureListener) {
    void listener;
    return () => {};
  }

  function subscribeToRequests(listener: RequestListener) {
    requestListeners.add(listener);
    return () => requestListeners.delete(listener);
  }

  return {
    requests,
    responsesSent,
    onNotification: subscribeToNotifications,
    onRequest: subscribeToRequests,
    onDidFail: subscribeToFailures,
    async request(method: string, params?: unknown) {
      const normalizedParams = requestParameters(params);
      requests.push({ method, params: normalizedParams });
      const response = responses[method] ?? (method === 'model/list' ? { data: [{
        id: 'test-model', model: 'test-model', displayName: 'Test model', description: '', isDefault: true,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }],
        serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
      }] } : undefined);
      if (typeof response === 'function') return await response(normalizedParams);
      if (response instanceof Error) throw response;
      if (response !== undefined) return response;
      throw new Error(`Unexpected method: ${method}`);
    },
    async respond(id: string | number, result: unknown) {
      responsesSent.push({ id, result });
    },
    emit(method: string, params: JsonObject) {
      for (const listener of notificationListeners) listener({ method, params });
    },
    emitRequest(id: string | number, method: string, params: JsonObject) {
      for (const listener of requestListeners) listener({ id, method, params });
    },
  };
}

export function createCodexChatService(
  client: CodexChatClient & { stop?: () => Promise<void> },
  createMcpProbeClient = () => ({ request: client.request, stop: () => client.stop?.() ?? Promise.resolve() }),
) {
  return new CodexChatService({
    client,
    createMcpProbeClient,
    cwd: '/workspace/cheshi',
    serviceName: 'cheshi',
    developerInstructions: 'Inspect the project in a read-only sandbox.',
  });
}

export async function expectFailure(operation: () => Promise<unknown>, expectedMessage: string) {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error('Expected the operation to reject with an Error.');
    expect(error.message).toBe(expectedMessage);
    return;
  }
  throw new Error('Expected the operation to fail.');
}
