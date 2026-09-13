import { isAbsolute } from 'node:path';
import { TemporaryChatClosedError, temporaryChatRequest, type TemporaryChatResult } from '../shared/temporary-chat.ts';
import { modelsFromListResponse } from './codex-chat-catalog.mts';
import type { ChatModel, CodexChatClient, JsonObject } from './codex-chat-types.mts';
import { messageWithFileReferences } from './codex-chat-values.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

export type TemporaryChatClient = CodexChatClient & { stop(): Promise<void> };

interface TemporaryChatOptions {
  createClient(): TemporaryChatClient;
  cwd: string;
  timeoutMs?: number;
}

const INSTRUCTIONS = [
  'You are having a temporary conversation with the user. Continue the conversation across turns.',
  'This conversation is not saved to the application chat history and ends when its window closes.',
  'Do not save or update persistent memory, conversation records, or files. Do not send messages externally.',
  'Use read-only tools only when needed to answer the user or inspect their attached files.',
  'Do not request approvals or interactive tool input. Ask any needed question in your response.',
].join('\n');

function assertAvailable(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then((value) => {
      signal.removeEventListener('abort', onAbort);
      if (!signal.aborted) resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

type TurnOutcome = { text: string } | { error: Error };

/** One isolated app-server and ephemeral thread for the lifetime of one open panel. */
export class TemporaryChatService {
  private readonly client: TemporaryChatClient;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly lifetime = new AbortController();
  private readonly removeFailure: () => void;
  private readonly removeRequest: () => void;
  private closeFlight: Promise<void> | null = null;
  private modelFlight: Promise<ChatModel[]> | null = null;
  private threadId: string | null = null;
  private sending = false;

  constructor(options: TemporaryChatOptions) {
    this.client = options.createClient();
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.removeFailure = this.client.onDidFail((error) => this.fail(error));
    this.removeRequest = this.client.onRequest(() => {
      this.fail(new Error('Temporary chat cannot use interactive tools. Close and reopen the chat to continue.'));
    });
  }

  private assertOpen(): void {
    this.lifetime.signal.throwIfAborted();
  }

  private fail(error: Error): void {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(error);
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    if (!this.lifetime.signal.aborted) this.lifetime.abort(new TemporaryChatClosedError());
    this.threadId = null;
    this.modelFlight = null;
    this.removeFailure();
    this.removeRequest();
    // Stop the owned process: unsubscribe alone does not unload ephemeral threads.
    // Schedule once so a synchronous transport callback cannot recursively stop it.
    this.closeFlight = Promise.resolve().then(() => this.client.stop());
    return this.closeFlight;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    this.assertOpen();
    return abortable(this.client.request(method, params, this.timeoutMs), this.lifetime.signal);
  }

  async models(): Promise<ChatModel[]> {
    this.assertOpen();
    this.modelFlight ??= this.loadModels();
    return this.modelFlight;
  }

  private async loadModels(): Promise<ChatModel[]> {
    const timer = setTimeout(() => this.fail(new Error('Temporary chat model loading timed out. Close and reopen the chat.')), this.timeoutMs);
    try {
      const result = modelsFromListResponse(await this.request('model/list', { limit: 100, includeHidden: false }));
      this.assertOpen();
      return result;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(value: unknown): Promise<TemporaryChatResult> {
    const request = temporaryChatRequest(value);
    this.assertOpen();
    assertAvailable(!this.sending, 'A temporary chat response is already in progress.');
    for (const attachment of request.attachments) {
      assertAvailable(isAbsolute(attachment.path), 'Temporary chat attachments require absolute file paths.');
    }
    this.sending = true;
    const timer = setTimeout(() => this.fail(new Error('Temporary chat response timed out. Close and reopen the chat.')), this.timeoutMs);
    try {
      const models = await this.models();
      this.assertOpen();
      const model = models.find((entry) => entry.model === request.model);
      assertAvailable(model, `${request.model} is not available on the connected Codex account.`);
      assertAvailable(model.supportedReasoningEfforts.some(({ effort }) => effort === request.effort),
        `${request.model} ${request.effort} is not available on the connected Codex account.`);
      if (!this.threadId) {
        const started = recordValue(await this.request('thread/start', {
          model: model.model, allowProviderModelFallback: false,
          cwd: this.cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
          developerInstructions: INSTRUCTIONS,
          environments: [], selectedCapabilityRoots: [], dynamicTools: [],
        }));
        this.assertOpen();
        const thread = recordValue(started?.thread);
        assertAvailable(thread?.ephemeral === true, 'Codex did not confirm an in-memory session.');
        assertAvailable(started?.model === model.model, 'Codex returned a different model than requested.');
        const threadId = stringValue(thread.id);
        assertAvailable(threadId, 'Codex did not create a temporary session.');
        this.threadId = threadId;
      }
      const input: JsonObject[] = [{
        type: 'text', text: messageWithFileReferences(request.text, request.attachments), text_elements: [],
      }];
      for (const attachment of request.attachments) {
        if (attachment.kind === 'image') input.push({ type: 'localImage', path: attachment.path });
      }
      const text = await this.runTurn({
        threadId: this.threadId, model: model.model, effort: request.effort,
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
        environments: [], input,
      });
      this.assertOpen();
      return { text, model: model.model };
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearTimeout(timer);
      this.sending = false;
    }
  }

  private async runTurn(params: JsonObject): Promise<string> {
    let turnId: string | null = null;
    const pending: JsonObject[] = [];
    const messages = new Map<string, { text: string; phase: unknown }>();
    let finish!: (outcome: TurnOutcome) => void;
    const completed = new Promise<TurnOutcome>((resolve) => { finish = resolve; });
    const remember = (value: unknown) => {
      const item = recordValue(value);
      if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
        messages.set(item.id, { text: item.text, phase: item.phase });
      }
    };
    const handle = (event: JsonObject) => {
      const eventParams = recordValue(event.params);
      if (!eventParams || eventParams.threadId !== params.threadId) return;
      const turn = recordValue(eventParams.turn);
      const eventTurnId = stringValue(eventParams.turnId) ?? stringValue(turn?.id);
      if (eventTurnId && eventTurnId !== turnId) return;
      if (event.method === 'item/completed') remember(eventParams.item);
      if (event.method === 'error' && eventParams.willRetry !== true) {
        finish({ error: new Error(stringValue(recordValue(eventParams.error)?.message) ?? 'Temporary chat failed.') });
      }
      if (event.method !== 'turn/completed') return;
      if (Array.isArray(turn?.items)) turn.items.forEach(remember);
      if (turn?.status !== 'completed') {
        finish({ error: new Error(stringValue(recordValue(turn?.error)?.message) ?? 'Temporary chat was interrupted.') });
        return;
      }
      const text = [...messages.values()].filter((item) => item.phase !== 'commentary')
        .map((item) => item.text).join('\n\n').trim();
      finish(text ? { text } : { error: new Error('No response was returned.') });
    };
    const removeNotification = this.client.onNotification((event) => {
      if (event.method !== 'item/completed' && event.method !== 'turn/completed' && event.method !== 'error') return;
      if (recordValue(event.params)?.threadId !== params.threadId) return;
      if (!turnId) pending.push(event);
      else handle(event);
    });
    try {
      const started = recordValue(await this.request('turn/start', params));
      this.assertOpen();
      turnId = stringValue(recordValue(started?.turn)?.id);
      assertAvailable(turnId, 'Codex did not return a temporary chat turn id.');
      for (const event of pending) handle(event);
      pending.length = 0;
      const outcome = await abortable(completed, this.lifetime.signal);
      if ('error' in outcome) return Promise.reject(outcome.error);
      return outcome.text;
    } finally {
      removeNotification();
    }
  }
}
