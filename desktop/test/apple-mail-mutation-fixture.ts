import vm from 'node:vm';
import { appleMailScript, type MailCommand } from '../lib/apple-mail-script.mts';

interface Reference { id?(): number | string; name?(): string; messageId?(): string }
function collection<T extends Reference>(items: T[], reference = (index: number) => items[index]!) {
  return new Proxy(Object.assign(() => items.map((_, index) => reference(index)), {
    push: (item: T) => items.push(item),
    byId: (id: string | number) => items.find(item => item.id?.() === id) ?? { exists: () => false },
    whose: (query: { messageId: string }) => () => items.filter(item => item.messageId?.() === query.messageId),
  }), { get(target, key, receiver) {
    if (key === 'length') return items.length;
    if (typeof key === 'string' && /^\d+$/.test(key)) return reference(Number(key));
    return Reflect.get(target, key, receiver);
  } });
}
function property<T>(value: T) {
  return { get: () => () => value, set: (next: T) => { value = next; }, configurable: true };
}
interface Recipient extends Reference { address(): string }
interface Outgoing {
  sender(): string; subject(): string; content(): string;
  toRecipients: ReturnType<typeof collection<Recipient>>;
  ccRecipients: ReturnType<typeof collection<Recipient>>;
  bccRecipients: ReturnType<typeof collection<Recipient>>;
}
interface MutationOptions {
  sendResult?: unknown; sendThrows?: boolean; ambiguous?: boolean;
  moveMode?: 'renumber' | 'noop' | 'copy' | 'lost' | 'delayed';
  existingCopy?: boolean; messageId?: string; recipientDeleteIgnored?: boolean;
  moveReadFailures?: number;
}
export function mailMutationFixture(options: MutationOptions = {}) {
  const actions: string[] = [];
  const positions = new WeakMap<Recipient, { entries: Recipient[]; index: number }>();
  let outgoing: Outgoing | undefined;
  let pendingMove: (() => void) | undefined;
  const recipientList = (addresses: string[] = []) => {
    const entries = addresses.map(address => ({ address: () => address }));
    return collection<Recipient>(entries, index => {
      // Native JXA resolves recipient references by their current position.
      const recipient = { address: () => entries[index]!.address() };
      positions.set(recipient, { entries, index });
      return recipient;
    });
  };
  function makeOutgoing(replyAll = false): Outgoing {
    return Object.defineProperties({
      toRecipients: recipientList(replyAll ? ['native-reply@example.test', 'second@example.test', 'third@example.test'] : ['native-reply@example.test']),
      ccRecipients: recipientList(replyAll ? ['old-cc1@example.test', 'old-cc2@example.test'] : []),
      bccRecipients: recipientList(replyAll ? ['old-bcc1@example.test', 'old-bcc2@example.test'] : []),
    }, { sender: property(''), subject: property(''), content: property('') }) as Outgoing;
  }
  const message = Object.defineProperties({ id: () => 1, exists: () => true, messageId: () => options.messageId ?? 'original@example.test' }, {
    readStatus: property(false), flaggedStatus: property(false),
  }) as { id(): number; exists(): boolean; messageId(): string; readStatus(): boolean; flaggedStatus(): boolean };
  const inboxMessages = [message];
  const trashMessages: typeof inboxMessages = [];
  if (options.existingCopy) trashMessages.push({ ...message, id: () => 20 });
  const boxes = [
    { name: () => 'INBOX', messages: collection(inboxMessages), mailboxes: collection([]) },
    { name: () => 'Trash', messages: collection(trashMessages), mailboxes: collection([]) },
  ];
  if (options.ambiguous) boxes.push({ ...boxes[0]! });
  const matchingTrashMessages = boxes[1]!.messages.whose;
  let moveReadFailures = options.moveReadFailures ?? 0;
  boxes[1]!.messages.whose = query => {
    if (actions.includes('move') && moveReadFailures-- > 0) throw Object.assign(new Error('Invalid index'), { errorNumber: -1719 });
    return matchingTrashMessages(query);
  };
  const account = { id: () => 'account-a', name: () => 'Personal', exists: () => true, enabled: () => true,
    emailAddresses: () => ['me@example.test'], mailboxes: collection(boxes) };
  const app = {
    accounts: collection([account]), mailboxes: collection([]),
    OutgoingMessage: () => { actions.push('create'); outgoing = makeOutgoing(); return outgoing; },
    outgoingMessages: { push: () => { actions.push('insert'); } },
    ToRecipient: (input: { address: string }) => ({ address: () => input.address }),
    CcRecipient: (input: { address: string }) => ({ address: () => input.address }),
    BccRecipient: (input: { address: string }) => ({ address: () => input.address }),
    extractAddressFrom: (value: string) => value,
    delete: (recipient: Recipient) => {
      const position = positions.get(recipient);
      if (!position) throw new Error('Only outgoing recipients may be removed');
      actions.push('recipient-delete');
      if (!options.recipientDeleteIgnored) position.entries.splice(position.index, 1);
    },
    reply: (original: unknown, settings: { openingWindow: boolean; replyToAll: boolean }) => {
      if (original !== message || settings.openingWindow !== false) throw new Error('Wrong reply target');
      actions.push(settings.replyToAll ? 'reply-all' : 'reply'); outgoing = makeOutgoing(settings.replyToAll); return outgoing;
    },
    send: (value: Outgoing) => {
      if (value !== outgoing) throw new Error('Wrong outgoing message');
      actions.push('send');
      if (options.sendThrows) throw Object.assign(new Error('private'), { errorNumber: -1712 });
      return options.sendResult === undefined ? true : options.sendResult;
    },
    move: (original: unknown, settings: { to: typeof boxes[number] }) => {
      if (original !== message || settings.to !== boxes[1]) throw new Error('Wrong move target');
      actions.push('move');
      if (options.moveMode === 'noop') return;
      const apply = () => {
        if (options.moveMode !== 'copy') inboxMessages.splice(0, 1);
        if (options.moveMode !== 'lost') trashMessages.push({ ...message, id: () => options.moveMode ? 2 : 1 });
      };
      if (options.moveMode === 'delayed') pendingMove = apply;
      else apply();
    },
  };
  return { actions, message, outgoing: () => outgoing, trashMessages,
    run: (command: MailCommand): unknown => JSON.parse(vm.runInNewContext(appleMailScript(command), {
      Application: () => app, delay: () => { pendingMove?.(); pendingMove = undefined; },
    })) };
}
