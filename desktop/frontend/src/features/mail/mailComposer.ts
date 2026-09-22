import { MAIL_ERRORS, mailAddress, mailSend } from '../../../../shared/apple-mail';
import type { AppleMailApi, MailAccount, MailMessage, MailSend, MailTarget } from '../../../../shared/apple-mail';

export interface MailForm {
  accountId: string; sender: string; to: string; cc: string; bcc: string; subject: string; body: string;
}
interface ComposerState {
  visible: boolean; form: MailForm | null; accounts: MailAccount[]; loading: boolean; busy: boolean;
  error: string | null; notice: string | null; blocked: boolean; confirmation: MailSend | null;
  reply: MailSend['reply'];
}
function address(value: string): string {
  const trimmed = value.trim();
  return trimmed.match(/<([^<>]+)>$/)?.[1]?.trim() ?? trimmed;
}
function recipients(value: string): string[] {
  return value.split(/[,;\n]/).map(part => part.trim()).filter(Boolean).map(mailAddress);
}
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => { const key = value.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

export class MailComposer {
  private readonly api: AppleMailApi;
  private state: ComposerState = { visible: false, form: null, accounts: [], loading: false, busy: false,
    error: null, notice: null, blocked: false, confirmation: null, reply: null };
  private readonly listeners = new Set<() => void>();
  constructor(api: AppleMailApi) { this.api = api; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ComposerState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  async start(message?: MailMessage, target?: MailTarget, all = false) {
    if (this.state.form || this.state.loading) { this.update({ visible: true }); return; }
    this.update({ visible: true, loading: true, error: null, notice: null });
    try {
      const response = await this.api.accounts();
      if (!response.ok) { this.update({ loading: false, error: response.error.message }); return; }
      const accounts = response.value.filter(account => account.addresses.length > 0);
      const account = accounts.find(account => account.id === target?.mailbox.accountId) ?? accounts[0];
      if (!account) { this.update({ loading: false, error: '발신 가능한 계정이 없습니다. Apple Mail의 계정을 확인해 주세요.' }); return; }
      const own = new Set(accounts.flatMap(account => account.addresses).map(value => value.toLowerCase()));
      const replyTo = message ? address(message.replyTo || message.sender) : '';
      const to = message ? unique([replyTo, ...(all ? message.to.map(address) : [])]).filter(value => value && (!all || !own.has(value.toLowerCase()))) : [];
      const included = new Set(to.map(value => value.toLowerCase()));
      const cc = message && all ? unique(message.cc.map(address)).filter(value => value && !own.has(value.toLowerCase()) && !included.has(value.toLowerCase())) : [];
      this.update({ loading: false, accounts, reply: target ? { target, all } : null,
        form: { accountId: account.id, sender: account.addresses[0]!, to: to.join(', '), cc: cc.join(', '), bcc: '',
          subject: message ? (/^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`) : '', body: '' } });
    } catch { this.update({ loading: false, error: MAIL_ERRORS.unavailable }); }
  }
  edit(patch: Partial<MailForm>) {
    if (!this.state.form || this.state.busy || this.state.blocked) return;
    this.update({ form: { ...this.state.form, ...patch }, confirmation: null, error: null });
  }
  review() {
    if (!this.state.form || this.state.busy || this.state.blocked) return;
    const form = this.state.form;
    try {
      const input = mailSend({ ...form, operationId: crypto.randomUUID(), to: recipients(form.to), cc: recipients(form.cc),
        bcc: recipients(form.bcc), reply: this.state.reply });
      this.update({ confirmation: input, error: null });
    } catch { this.update({ error: '발신 계정과 받는 사람 주소를 확인해 주세요. 주소는 쉼표로 구분하고 제목은 1,000자 이내로 입력해 주세요.' }); }
  }
  back() { if (!this.state.busy) this.update({ confirmation: null }); }
  hide() { if (!this.state.busy && !this.state.loading) this.update({ visible: false, confirmation: null }); }
  discard() {
    if (!this.state.busy && !this.state.loading) this.update({ visible: false, form: null, reply: null,
      confirmation: null, error: null, blocked: false });
  }
  async send() {
    const input = this.state.confirmation;
    if (!input || this.state.busy || this.state.blocked) return;
    this.update({ busy: true, error: null });
    try {
      const result = await this.api.send(input);
      if (result.ok) this.update({ busy: false, visible: false, form: null, reply: null, confirmation: null,
        notice: 'Mail에 발송을 요청했습니다. 전송 상태는 보낼 편지함·보낸 편지함에서 확인할 수 있습니다.' });
      else this.update({ busy: false, confirmation: null, error: result.error.message, blocked: result.error.code === 'send-unknown' });
    } catch { this.update({ busy: false, confirmation: null, error: MAIL_ERRORS['send-unknown'], blocked: true }); }
  }
}

// Keep unfinished text across Mail navigation in this renderer session, without writing message bodies to disk.
const composers = new WeakMap<AppleMailApi, MailComposer>();
export function mailComposer(api: AppleMailApi): MailComposer {
  let composer = composers.get(api);
  if (!composer) { composer = new MailComposer(api); composers.set(api, composer); }
  return composer;
}
