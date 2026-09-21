import { ephemeralSessionRequest, type EphemeralSessionResult } from '../shared/ephemeral-session.ts';
import { modelsFromListResponse } from './codex-chat-catalog.mts';
import type { CodexChatClient, JsonObject } from './codex-chat-types.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

export interface EphemeralRunOptions {
  signal?: AbortSignal;
  outputSchema?: unknown;
  serviceTier?: 'default';
  disableTools?: boolean;
  webSearchOnly?: boolean;
  onWebSearch?: () => void;
  requireSubscription?: boolean;
  onTurnRequested?: () => void;
  onUsage?: (value: unknown) => void;
}

interface ActiveSession {
  abort: AbortController;
  threadId: string | null;
  turnId: string | null;
}

function assertAvailable(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal, onLateResult?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then((value) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onLateResult?.(value);
      else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/** Use a dedicated app-server client to keep temporary events outside the chat timeline. */
export class EphemeralSessionService {
  private active = new Map<string, ActiveSession>();
  private stopped = false;
  private client: CodexChatClient;
  private cwd: string;
  private timeoutMs: number;

  constructor(
    client: CodexChatClient,
    cwd: string,
    timeoutMs = 90_000,
  ) {
    this.client = client;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
  }

  cancel(requestId: string): void {
    this.active.get(requestId)?.abort.abort(new Error('Temporary session canceled.'));
  }

  get busy(): boolean { return this.active.size > 0; }

  stop(): void {
    this.stopped = true;
    for (const requestId of this.active.keys()) this.cancel(requestId);
  }

  private release(threadId: string | null, turnId: string | null = null): void {
    if (!threadId || this.stopped) return;
    const interrupted = turnId
      ? this.client.request('turn/interrupt', { threadId, turnId }, 5000).catch(() => undefined)
      : Promise.resolve();
    void interrupted.then(() => {
      if (!this.stopped) return this.client.request('thread/unsubscribe', { threadId }, 5000);
      return undefined;
    }).catch(() => undefined);
  }

  async run(value: unknown, options: EphemeralRunOptions = {}): Promise<EphemeralSessionResult> {
    const request = ephemeralSessionRequest(value);
    assertAvailable(!this.stopped, 'Temporary session service has stopped.');
    assertAvailable(!this.active.has(request.requestId), 'A temporary session with this request id is already running.');
    const active: ActiveSession = { abort: new AbortController(), threadId: null, turnId: null };
    this.active.set(request.requestId, active);
    const signal = active.abort.signal;
    const externalAbort = () => active.abort.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) externalAbort();
    const messages = new Map<string, { text: string; phase: unknown }>();
    let turnCompleted = false;
    type Outcome = { text: string } | { error: Error };
    let finish!: (outcome: Outcome) => void;
    const completed = new Promise<Outcome>((resolve) => { finish = resolve; });
    const onAbort = () => finish({ error: signal.reason as Error });
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => active.abort.abort(new Error('Temporary session timed out. Please try again.')), this.timeoutMs);
    const remember = (value: unknown) => {
      const item = recordValue(value);
      if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
        messages.set(item.id, { text: item.text, phase: item.phase });
      }
    };
    const removeNotification = this.client.onNotification((event: JsonObject) => {
      const params = recordValue(event.params);
      if (!active.threadId || params?.threadId !== active.threadId) return;
      const turn = recordValue(params.turn);
      const turnId = stringValue(params.turnId) ?? stringValue(turn?.id);
      if (turnId && active.turnId && turnId !== active.turnId) return;
      if (turnId) active.turnId = turnId;
      if (event.method === 'thread/tokenUsage/updated') options.onUsage?.(params.tokenUsage);
      const itemType = recordValue(params.item)?.type;
      if ((options.disableTools || options.webSearchOnly) && event.method === 'item/started'
        && ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange',
          ...(options.disableTools ? ['webSearch'] : [])].includes(String(itemType))) {
        active.abort.abort(new Error('This temporary session cannot use that tool.'));
      }
      if (event.method === 'item/completed' && itemType === 'webSearch') options.onWebSearch?.();
      if (event.method === 'item/completed') remember(params.item);
      if (event.method === 'error' && params.willRetry !== true) {
        finish({ error: new Error(stringValue(recordValue(params.error)?.message) ?? 'Temporary session failed.') });
      }
      if (event.method !== 'turn/completed') return;
      turnCompleted = true;
      if (Array.isArray(turn?.items)) turn.items.forEach(remember);
      if (turn?.status !== 'completed') {
        finish({ error: new Error(stringValue(recordValue(turn?.error)?.message) ?? 'Temporary session was interrupted.') });
        return;
      }
      const text = [...messages.values()].filter((item) => item.phase !== 'commentary').map((item) => item.text).join('\n\n').trim();
      finish(text ? { text } : { error: new Error('No response was returned.') });
    });
    const removeFailure = this.client.onDidFail((error) => active.abort.abort(error));
    const removeRequest = this.client.onRequest((event) => {
      if (recordValue(event.params)?.threadId !== active.threadId) return;
      active.abort.abort(new Error('Temporary session cannot use interactive tools.'));
    });

    try {
      signal.throwIfAborted();
      if (options.requireSubscription) {
        const account = recordValue(await abortable(this.client.request('account/read', {}), signal));
        assertAvailable(recordValue(account?.account)?.type === 'chatgpt', 'Sign in with a ChatGPT subscription to use Luna history fallback.');
      }
      let config: Record<string, unknown> | undefined;
      if (options.disableTools || options.webSearchOnly) {
        const response = recordValue(await abortable(this.client.request('config/read', { includeLayers: false, cwd: this.cwd }), signal));
        const effective = recordValue(response?.config);
        assertAvailable(effective, 'Could not read configuration for isolated history classification.');
        const servers = recordValue(effective.mcp_servers) ?? {};
        config = { mcp_servers: Object.fromEntries(Object.entries(servers).map(([name, value]) =>
          [name, { ...recordValue(value), enabled: false }])),
          'features.shell_tool': false, 'features.multi_agent': false,
          'web_search': options.disableTools ? 'disabled' : 'live' };
      }
      const models = modelsFromListResponse(await abortable(this.client.request('model/list', { limit: 100, includeHidden: false }), signal));
      signal.throwIfAborted();
      const model = models.find((entry) => entry.model === request.model);
      assertAvailable(model, `${request.model} is not available on the connected Codex account.`);
      assertAvailable(model.supportedReasoningEfforts.some(({ effort }) => effort === request.effort), `${request.model} ${request.effort} is not available on the connected Codex account.`);
      const started = recordValue(await abortable(this.client.request('thread/start', {
        model: model.model, allowProviderModelFallback: false,
        ...(options.requireSubscription ? { modelProvider: 'openai' } : {}),
        ...(config ? { config } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        cwd: this.cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: request.instructions, developerInstructions: request.instructions,
        environments: [], selectedCapabilityRoots: [], dynamicTools: [],
      }), signal, (late) => this.release(stringValue(recordValue(recordValue(late)?.thread)?.id))));
      active.threadId = stringValue(recordValue(started?.thread)?.id);
      signal.throwIfAborted();
      assertAvailable(active.threadId, 'Codex did not create a temporary session.');
      assertAvailable(recordValue(started?.thread)?.ephemeral === true, 'Codex did not confirm an in-memory session.');
      assertAvailable(started?.model === model.model, 'Codex returned a different model than requested.');
      assertAvailable(!options.requireSubscription || started?.modelProvider === 'openai', 'Codex returned a different provider than requested.');
      assertAvailable(!options.serviceTier || started?.serviceTier == null || started.serviceTier === options.serviceTier,
        'Codex returned a different service tier than requested.');
      options.onTurnRequested?.();
      const turn = recordValue(await abortable(this.client.request('turn/start', {
        threadId: active.threadId, model: model.model, effort: request.effort,
        ...(options.serviceTier ? { serviceTier: options.serviceTier, serviceTierForTurn: options.serviceTier } : {}),
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
        environments: [],
        input: [{ type: 'text', text: request.input, text_elements: [] }],
      }), signal, (late) => this.release(active.threadId, stringValue(recordValue(recordValue(late)?.turn)?.id))));
      active.turnId = stringValue(recordValue(turn?.turn)?.id) ?? active.turnId;
      signal.throwIfAborted();
      const outcome = await completed;
      signal.throwIfAborted();
      if ('error' in outcome) return Promise.reject(outcome.error);
      return { text: outcome.text, model: model.model };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', externalAbort);
      signal.removeEventListener('abort', onAbort);
      removeNotification();
      removeFailure();
      removeRequest();
      if (this.active.get(request.requestId) === active) this.active.delete(request.requestId);
      this.release(active.threadId, turnCompleted ? null : active.turnId);
    }
  }
}
