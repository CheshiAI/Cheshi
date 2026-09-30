import { MAIL_PAGE_SIZE, mailFailure, mailboxKey } from '../../../../shared/apple-mail';
import type { AppleMailApi, Mailbox, MailMessage, MailPage, MailReply, MailChange } from '../../../../shared/apple-mail';

export interface MailState {
  connected: boolean;
  boxes: Mailbox[];
  selectedBox: Mailbox | null;
  page: MailPage | null;
  selectedId: number | null;
  message: MailMessage | null;
  loadingBoxes: boolean;
  loadingPage: boolean;
  loadingMore: boolean;
  loadingBody: boolean;
  boxesError: string | null;
  pageError: string | null;
  moreError: string | null;
  bodyError: string | null;
  changing: boolean;
  changeError: string | null;
  changeBlocked: boolean;
}

export class MailModel {
  private state: MailState = { connected: false, boxes: [], selectedBox: null, page: null, selectedId: null,
    message: null, loadingBoxes: false, loadingPage: false, loadingMore: false, loadingBody: false,
    boxesError: null, pageError: null, moreError: null, bodyError: null, changing: false, changeError: null, changeBlocked: false };
  private readonly listeners = new Set<() => void>();
  private readonly api: AppleMailApi;
  private boxesVersion = 0;
  private pageVersion = 0;
  private bodyVersion = 0;
  constructor(api: AppleMailApi) { this.api = api; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  cancelPending = () => { ++this.boxesVersion; ++this.pageVersion; ++this.bodyVersion; };
  private update(patch: Partial<MailState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private async request<T>(run: () => Promise<MailReply<T>>): Promise<MailReply<T>> {
    try { return await run(); } catch { return mailFailure('unavailable'); }
  }
  private async listWindow(box: Mailbox, offset: number, count: number, current: () => boolean): Promise<MailReply<MailPage> | null> {
    const messages = new Map<number, MailPage['messages'][number]>();
    let nextOffset: number | null = offset;
    do {
      const result = await this.request(() => this.api.list(box, nextOffset!));
      if (!current()) return null;
      if (!result.ok) return result;
      for (const message of result.value.messages) messages.set(message.id, message);
      nextOffset = result.value.nextOffset;
    } while (nextOffset !== null && nextOffset < offset + Math.max(count, MAIL_PAGE_SIZE));
    return { ok: true, value: { messages: [...messages.values()], offset, nextOffset } };
  }
  async connect() {
    if (this.state.changing) return;
    this.cancelPending();
    const version = this.boxesVersion;
    const previous = this.state;
    this.update({ loadingBoxes: true, loadingPage: false, loadingMore: false, moreError: null, loadingBody: false, boxesError: null, pageError: null,
      bodyError: null, changeError: null });
    const result = await this.request(() => this.api.mailboxes());
    if (version !== this.boxesVersion) return;
    if (!result.ok) {
      this.update({ loadingBoxes: false, boxesError: result.error.message });
      return;
    }
    const selected = result.value.find(box => previous.selectedBox && mailboxKey(box) === mailboxKey(previous.selectedBox))
      ?? result.value.find(box => /^(inbox|받은 편지함)$/i.test(box.path.at(-1) ?? '')) ?? result.value[0] ?? null;
    const sameBox = selected !== null && previous.selectedBox !== null
      && mailboxKey(selected) === mailboxKey(previous.selectedBox);
    const resultPage = selected
      ? await this.listWindow(selected, sameBox ? previous.page?.offset ?? 0 : 0,
        sameBox ? previous.page?.messages.length ?? MAIL_PAGE_SIZE : MAIL_PAGE_SIZE, () => version === this.boxesVersion) : null;
    if (version !== this.boxesVersion) return;
    const page = resultPage?.ok ? resultPage.value : sameBox ? previous.page : null;
    const selectedMessage = sameBox ? page?.messages.find(message => message.id === previous.selectedId) : undefined;
    // Publish both stages together so refresh never clears the retained view between requests.
    this.update({ connected: true, boxes: result.value, selectedBox: selected, loadingBoxes: false,
      page, pageError: resultPage && !resultPage.ok ? resultPage.error.message : null,
      selectedId: selectedMessage?.id ?? null,
      message: selectedMessage && previous.message ? { ...previous.message, ...selectedMessage } : null,
      changeBlocked: resultPage && !resultPage.ok ? previous.changeBlocked : false });
  }
  async selectMailbox(box: Mailbox, offset = 0, count = MAIL_PAGE_SIZE) {
    if (this.state.changing || this.state.loadingBoxes) return;
    const version = ++this.pageVersion;
    ++this.bodyVersion;
    this.update({ selectedBox: box, page: null, selectedId: null, message: null,
      loadingPage: true, loadingMore: false, moreError: null, loadingBody: false, pageError: null, bodyError: null });
    const result = await this.listWindow(box, offset, count, () => version === this.pageVersion);
    if (!result || version !== this.pageVersion) return;
    this.update(result.ok ? { page: result.value, loadingPage: false }
      : { pageError: result.error.message, loadingPage: false });
  }
  async selectMessage(id: number) {
    if (this.state.changing || this.state.loadingBoxes) return;
    const box = this.state.selectedBox;
    if (!box || !this.state.page?.messages.some(message => message.id === id)) return;
    const version = ++this.bodyVersion;
    this.update({ selectedId: id, message: null, loadingBody: true, bodyError: null });
    const result = await this.request(() => this.api.read({ mailbox: box, id }));
    if (version !== this.bodyVersion) return;
    this.update(result.ok ? { message: result.value, loadingBody: false }
      : { bodyError: result.error.message, loadingBody: false });
  }
  async loadMore() {
    const { selectedBox, page, loadingBoxes, loadingPage, loadingMore, changing } = this.state;
    if (!selectedBox || page?.nextOffset == null || loadingBoxes || loadingPage || loadingMore || changing) return;
    const version = ++this.pageVersion;
    this.update({ loadingMore: true, moreError: null });
    const result = await this.request(() => this.api.list(selectedBox, page.nextOffset!));
    if (version !== this.pageVersion) return;
    if (!result.ok) { this.update({ loadingMore: false, moreError: result.error.message }); return; }
    const messages = new Map(page.messages.map(message => [message.id, message]));
    for (const message of result.value.messages) messages.set(message.id, message);
    this.update({ loadingMore: false, page: { ...page, messages: [...messages.values()], nextOffset: result.value.nextOffset } });
  }
  async change(input: MailChange) {
    const { selectedBox, message, page } = this.state;
    if (this.state.changing || this.state.loadingBoxes || this.state.changeBlocked || !selectedBox || !message
      || message.id !== input.target.id || mailboxKey(selectedBox) !== mailboxKey(input.target.mailbox)) return;
    this.update({ changing: true, changeError: null });
    let result: MailReply<unknown>;
    try { result = await this.api.change(input); } catch { result = mailFailure('change-unknown'); }
    this.update({ changing: false });
    if (!result.ok) {
      this.update({ changeError: result.error.message, changeBlocked: true });
      return;
    }
    const offset = page?.offset ?? 0;
    await this.selectMailbox(selectedBox, offset, page?.messages.length ?? MAIL_PAGE_SIZE);
    if (this.state.page?.messages.length === 0 && offset > 0) await this.selectMailbox(selectedBox, Math.max(0, offset - MAIL_PAGE_SIZE));
    if (input.action !== 'move') await this.selectMessage(input.target.id);
    const boxes = await this.request(() => this.api.mailboxes());
    if (boxes.ok) this.update({ boxes: boxes.value });
  }
}
