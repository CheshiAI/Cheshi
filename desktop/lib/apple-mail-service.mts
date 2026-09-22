import { createHash } from 'node:crypto';
import { mailboxes, mailboxRef, mailOffset, mailPage, mailTarget, mailMessage, mailReply, mailFailure,
  mailAccounts, mailChange, mailChanged, mailSend, mailSent } from '../shared/apple-mail.ts';
import type { MailReply, MailSend, MailSent, MailErrorCode } from '../shared/apple-mail.ts';
import { appleMailScript, type MailCommand } from './apple-mail-script.mts';
import { MailProcessError, runMailScript } from './apple-mail-process.mts';

export class AppleMailService {
  private readonly platform: string;
  private readonly execute: (source: string) => Promise<string>;
  private readonly sends = new Map<string, { fingerprint: string; result: Promise<MailReply<MailSent>> }>();
  constructor(options: { platform?: string; execute?: (source: string) => Promise<string> } = {}) {
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? runMailScript;
  }
  mailboxes() { return this.request(() => ({ action: 'mailboxes' }), mailboxes); }
  accounts() { return this.request(() => ({ action: 'accounts' }), mailAccounts); }
  change(value: unknown) {
    return this.request(() => ({ action: 'change', input: mailChange(value) }), result => mailChanged(result, mailChange(value).target), 'change-unknown');
  }
  send(value: unknown): Promise<MailReply<MailSent>> {
    let input: MailSend;
    try { input = mailSend(value); } catch { return Promise.resolve(mailFailure('invalid')); }
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = this.sends.get(input.operationId);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.resolve(mailFailure('invalid'));
    // Keep acknowledgements for this app session; never evict and accidentally resend an old request.
    if (this.sends.size >= 200) return Promise.resolve(mailFailure('unavailable'));
    const result = this.request(() => ({ action: 'send', input }), result => mailSent(result, input.operationId), 'send-unknown');
    this.sends.set(input.operationId, { fingerprint, result });
    return result;
  }
  list(mailbox: unknown, offset: unknown = 0) {
    return this.request(() => ({ action: 'list', mailbox: mailboxRef(mailbox), offset: mailOffset(offset) }), value => mailPage(value, mailOffset(offset)));
  }
  read(target: unknown) {
    return this.request(() => ({ action: 'read', target: mailTarget(target) }), value => mailMessage(value, mailTarget(target).id));
  }
  private async request<T>(build: () => MailCommand, parse: (value: unknown) => T, uncertain?: MailErrorCode): Promise<MailReply<T>> {
    if (this.platform !== 'darwin') return mailFailure('unsupported');
    let command: MailCommand;
    try { command = build(); } catch { return mailFailure('invalid'); }
    let response: string;
    try { response = await this.execute(appleMailScript(command)); }
    catch (error) {
      if (uncertain) return mailFailure(uncertain);
      return mailFailure(error instanceof MailProcessError && error.reason === 'timeout' ? 'timeout'
        : error instanceof MailProcessError && error.reason === 'output' ? 'too-large' : 'unavailable');
    }
    try { return mailReply(JSON.parse(response), parse); }
    catch { return mailFailure(uncertain ?? 'invalid-response'); }
  }
}
