import type { IMessageCommandSettings, IMessageCommandTarget } from '../shared/imessage-commands.ts';
import { parseIMessageRecipient } from '../shared/imessage-notifications.ts';
import { openIMessageInbox, type IMessageInbox } from './imessage-inbox.mts';

export interface IMessageCommandEndpoint extends IMessageCommandTarget {
  execute(command: string, messageId: string, signal: AbortSignal): Promise<string | {
    reply: string;
    continuedTarget: IMessageCommandTarget;
  }>;
}
export interface IMessageCommandRegistry {
  register(key: string, targets: () => IMessageCommandEndpoint[]): () => void;
}
export function messageCommand(text: string | null): string | null {
  if (!text || text.length > 8000) return null;
  const match = /^체시(?:\s+|[,，:]\s*)(\S[\s\S]*)$/u.exec(text.trim());
  return match?.[1]?.trim() ?? null;
}
/** One reader per app. Arming starts at the current high-water mark; old messages never execute. */
export function createIMessageCommands(options: {
  recipient(): Promise<string>;
  reply(recipient: string, text: string): Promise<void>;
  open?: () => IMessageInbox;
  intervalMs?: number;
}) {
  const providers = new Map<string, () => IMessageCommandEndpoint[]>();
  let enabled = false, targetId: string | null = null, status = 'Off. Select an open conversation to receive commands.';
  let inbox: IMessageInbox | null = null, cursor = 0, recipient = '', revision = 0;
  let lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> = Promise.resolve();
  let configuring = false, disposed = false;
  const seen = new Set<string>();
  const targets = () => [...providers.values()].flatMap(provider => provider()).slice(0, 256);
  const snapshot = (): IMessageCommandSettings => ({ enabled, targetId, status,
    targets: targets().map(({ id, label }) => ({ id, label })) });
  const stop = (message: string) => {
    revision++; enabled = false; lifetime.abort(); clearTimeout(timer); timer = undefined;
    inbox?.close(); inbox = null; seen.clear(); status = message;
  };
  const poll = async () => {
    const generation = revision, address = recipient, signal = lifetime.signal;
    let selected = targetId;
    const current = () => enabled && generation === revision && !signal.aborted;
    try {
      if (!current() || !inbox) return;
      if ((await options.recipient()).toLowerCase() !== address.toLowerCase()) {
        if (current()) stop('Recipient changed. Enable message commands again.');
        return;
      }
      if (!current() || !inbox) return;
      if (!targets().some(target => target.id === selected)) { stop('The selected conversation is no longer open. Select it again.'); return; }
      const batch = inbox.read(cursor, address);
      cursor = batch.cursor;
      for (const message of batch.messages) {
        if (!current()) break;
        if (seen.has(message.guid)) continue;
        if (message.text === null) { status = 'An incoming message format is unsupported. Send a plain-text iMessage.'; continue; }
        seen.add(message.guid);
        if (seen.size > 2048) seen.delete(seen.values().next().value!);
        const command = messageCommand(message.text);
        if (!command) continue;
        let endpoint = targets().find(target => target.id === selected);
        if (!endpoint) { stop('The selected conversation is no longer open. Select it again.'); break; }
        let reply: string;
        try {
          const result = await endpoint.execute(command, `imessage:${message.guid}`, signal);
          reply = typeof result === 'string' ? result : result.reply;
          if (typeof result !== 'string' && current()) {
            const continued = targets().find(target => target.id === result.continuedTarget.id);
            if (!continued) { stop('The continued conversation is no longer open. Select it again.'); break; }
            selected = targetId = continued.id;
            endpoint = continued;
          }
        }
        catch (error) {
          reply = error instanceof Error && error.name === 'CodexMessageDeliveryUnknown'
            ? '지시 접수 여부를 확인하지 못했습니다. 앱을 확인해 주세요. 자동 재전송하지 않습니다.'
            : '지시를 처리하지 못했습니다. 앱의 대화와 대기 중인 요청을 확인해 주세요.';
        }
        if (!current()) break;
        status = reply;
        await options.reply(address, `Cheshi · ${endpoint.label}\n${reply}`);
      }
    } catch {
      if (current()) stop('Could not read Messages. Check Full Disk Access, then enable message commands again.');
    }
  };
  const schedule = () => {
    if (!enabled || disposed) return;
    timer = setTimeout(() => { flight = poll().finally(schedule); }, options.intervalMs ?? 1000);
    timer.unref?.();
  };
  return {
    register(key: string, provider: () => IMessageCommandEndpoint[]) {
      providers.set(key, provider);
      return () => {
        providers.delete(key);
        if (enabled && !targets().some(target => target.id === targetId)) stop('The selected workspace was closed.');
      };
    },
    get: snapshot,
    async configure(value: unknown) {
      if (disposed || configuring) throw new Error('Message command settings are unavailable.');
      if (!value || typeof value !== 'object') throw new TypeError('Invalid message command settings.');
      const request = value as Record<string, unknown>;
      if (typeof request.enabled !== 'boolean' || (request.targetId !== null && typeof request.targetId !== 'string')) throw new TypeError('Invalid message command settings.');
      configuring = true;
      stop('Off.');
      const generation = revision;
      try {
        await flight;
        if (disposed || generation !== revision) return snapshot();
        targetId = request.targetId as string | null;
        if (request.enabled) {
          if (!targets().some(target => target.id === targetId)) throw new Error('Select an open conversation first.');
          recipient = parseIMessageRecipient(await options.recipient());
          if (disposed || generation !== revision) return snapshot();
          inbox = (options.open ?? openIMessageInbox)();
          cursor = inbox.latest();
          lifetime = new AbortController(); enabled = true; status = 'Listening for new iMessages starting with 체시.';
          schedule();
        }
        return snapshot();
      } catch {
        stop('Could not enable commands. Save a recipient, select an open conversation, and allow Full Disk Access.');
        throw new Error(status);
      } finally { configuring = false; }
    },
    async dispose() { disposed = true; stop('Off.'); await flight; providers.clear(); },
  };
}
