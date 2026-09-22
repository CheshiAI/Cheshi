import type { IpcRenderer } from 'electron';
import { mailboxes, mailboxRef, mailOffset, mailPage, mailTarget, mailMessage, mailReply, mailFailure,
  mailAccounts, mailChange, mailChanged, mailSend, mailSent } from '../shared/apple-mail.ts';
import type { AppleMailApi, MailReply, MailErrorCode } from '../shared/apple-mail.ts';

export function createAppleMailApi(ipc: Pick<IpcRenderer, 'invoke'>, platform: string): AppleMailApi {
  const invoke = async <T,>(action: string, args: unknown[], parse: (value: unknown) => T, uncertain?: MailErrorCode): Promise<MailReply<T>> => {
    let reply: unknown;
    try { reply = await ipc.invoke(`cheshi:mail-${action}`, ...args); }
    catch { return mailFailure(uncertain ?? 'unavailable'); }
    try { return mailReply(reply, parse); }
    catch { return mailFailure(uncertain ?? 'invalid-response'); }
  };
  return {
    available: platform === 'darwin',
    mailboxes: () => invoke('mailboxes', [], mailboxes),
    accounts: () => invoke('accounts', [], mailAccounts),
    change: async value => {
      const input = mailChange(value);
      return invoke('change', [input], result => mailChanged(result, input.target), 'change-unknown');
    },
    send: async value => {
      const input = mailSend(value);
      return invoke('send', [input], result => mailSent(result, input.operationId), 'send-unknown');
    },
    list: async (mailbox, offset = 0) => invoke('list', [mailboxRef(mailbox), mailOffset(offset)], value => mailPage(value, offset)),
    read: async value => {
      const target = mailTarget(value);
      return invoke('read', [target], result => mailMessage(result, target.id));
    },
  };
}
