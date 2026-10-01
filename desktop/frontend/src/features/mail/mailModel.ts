import { MAIL_PAGE_SIZE, mailFailure, mailboxKey } from '../../../../shared/apple-mail';
import type { AppleMailApi, Mailbox, MailMessage, MailPage, MailReply, MailChange, MailTarget } from '../../../../shared/apple-mail';
import { mailTargetKey } from '../../../../shared/mail-conversation';
import type { MailConversation } from '../../../../shared/mail-conversation';

export interface MailState {
  connected: boolean;
  boxes: Mailbox[];
  selectedBox: Mailbox | null;
  page: MailPage | null;
  selectedId: number | null;
  message: MailMessage | null;
  remoteImagesAllowed: boolean;
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
  conversation: MailConversation | null;
  conversationMessages: Record<string, MailReply<MailMessage>>;
  loadingConversation: boolean;
  conversationError: string | null;
}

export class MailModel {
  private state: MailState = { connected: false, boxes: [], selectedBox: null, page: null, selectedId: null,
    message: null, remoteImagesAllowed: false, loadingBoxes: false, loadingPage: false, loadingMore: false, loadingBody: false,
    boxesError: null, pageError: null, moreError: null, bodyError: null, changing: false, changeError: null, changeBlocked: false,
    conversation: null, conversationMessages: {}, loadingConversation: false, conversationError: null };
  private readonly listeners = new Set<() => void>();
  private readonly api: AppleMailApi;
  private readonly imagePermissions = new Set<string>();
  private boxesVersion = 0;
  private pageVersion = 0;
  private bodyVersion = 0;
  private conversationVersion = 0;
  constructor(api: AppleMailApi) { this.api = api; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  cancelPending = () => { ++this.boxesVersion; ++this.pageVersion; ++this.bodyVersion; ++this.conversationVersion; };
  private update(patch: Partial<MailState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private async request<T>(run: () => Promise<MailReply<T>>): Promise<MailReply<T>> {
    try { return await run(); } catch { return mailFailure('unavailable'); }
  }
  private imageKey(box: Mailbox, id: number) { return `${mailboxKey(box)}:${id}`; }
  allowRemoteImages = () => {
    const { selectedBox, selectedId, message } = this.state;
    if (!selectedBox || !message?.html || message.id !== selectedId) return;
    this.imagePermissions.add(this.imageKey(selectedBox, message.id));
    this.update({ remoteImagesAllowed: true });
  };
  remoteImagesFor = (target: MailTarget) => this.imagePermissions.has(mailTargetKey(target));
  allowConversationImages = (target: MailTarget) => {
    if (!this.state.conversation?.messages.some(entry => mailTargetKey(entry.target) === mailTargetKey(target))) return;
    this.imagePermissions.add(mailTargetKey(target));
    this.update({});
  };
  refreshConversation = async () => {
    const { selectedBox, selectedId, message } = this.state;
    if (!selectedBox || selectedId === null || !message) return;
    const version = ++this.conversationVersion;
    this.update({ loadingConversation: true, conversationError: null });
    const result = await this.request(() => this.api.conversation({ mailbox: selectedBox, id: selectedId }));
    if (version !== this.conversationVersion) return;
    if (!result.ok) {
      this.update({ conversationError: result.error.message, loadingConversation: false, loadingBody: false });
      return;
    }
    const anchor = mailTargetKey({ mailbox: selectedBox, id: selectedId });
    // Fetch previews without changing read status, then publish the entire
    // conversation together. Keep the current content visible while fetching.
    const messages = await Promise.all(result.value.messages
      .filter(entry => mailTargetKey(entry.target) !== anchor)
      .map(async entry => [mailTargetKey(entry.target), await this.request(() => this.api.read(entry.target))] as const));
    if (version !== this.conversationVersion) return;
    this.update({ conversation: result.value, conversationMessages: Object.fromEntries(messages), loadingConversation: false, loadingBody: false });
  };
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
      bodyError: null, changeError: null, loadingConversation: false });
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
      remoteImagesAllowed: !!selected && !!selectedMessage && this.imagePermissions.has(this.imageKey(selected, selectedMessage.id)),
      message: selectedMessage && previous.message ? { ...previous.message, ...selectedMessage } : null,
      conversation: selectedMessage ? previous.conversation : null,
      conversationMessages: selectedMessage ? previous.conversationMessages : {}, conversationError: null,
      changeBlocked: resultPage && !resultPage.ok ? previous.changeBlocked : false });
    if (selectedMessage && previous.message) void this.refreshConversation();
  }
  async selectMailbox(box: Mailbox, offset = 0, count = MAIL_PAGE_SIZE) {
    if (this.state.changing || this.state.loadingBoxes) return;
    const version = ++this.pageVersion;
    ++this.bodyVersion;
    ++this.conversationVersion;
    this.update({ selectedBox: box, page: null, selectedId: null, message: null, remoteImagesAllowed: false,
      loadingPage: true, loadingMore: false, moreError: null, loadingBody: false, pageError: null, bodyError: null,
      conversation: null, conversationMessages: {}, loadingConversation: false, conversationError: null });
    const result = await this.listWindow(box, offset, count, () => version === this.pageVersion);
    if (!result || version !== this.pageVersion) return;
    this.update(result.ok ? { page: result.value, loadingPage: false }
      : { pageError: result.error.message, loadingPage: false });
  }
  async selectMessage(id: number) {
    await this.loadMessage(id, true);
  }
  private async loadMessage(id: number, markAsRead: boolean) {
    if (this.state.changing || this.state.loadingBoxes) return;
    const box = this.state.selectedBox;
    if (!box || !this.state.page?.messages.some(message => message.id === id)) return;
    const version = ++this.bodyVersion;
    ++this.conversationVersion;
    this.update({ selectedId: id, message: null, loadingBody: true, bodyError: null,
      remoteImagesAllowed: this.imagePermissions.has(this.imageKey(box, id)),
      conversation: null, conversationMessages: {}, loadingConversation: false, conversationError: null });
    const result = await this.request(() => this.api.read({ mailbox: box, id }));
    if (version !== this.bodyVersion) return;
    this.update(result.ok ? { message: result.value }
      : { bodyError: result.error.message, loadingBody: false });
    if (result.ok && !result.value.read && markAsRead && version === this.bodyVersion) {
      await this.markOpenedMessageRead(box, id, version);
    }
    if (result.ok && version === this.bodyVersion) void this.refreshConversation();
  }
  private async markOpenedMessageRead(box: Mailbox, id: number, version: number) {
    if (this.state.changing || this.state.changeBlocked) return;
    this.update({ changing: true, changeError: null });
    let result: MailReply<unknown>;
    try { result = await this.api.change({ action: 'read', target: { mailbox: box, id }, value: true }); }
    catch { result = mailFailure('change-unknown'); }
    if (version !== this.bodyVersion) {
      this.update({ changing: false });
      return;
    }
    if (!result.ok) {
      this.update({ changing: false, changeError: result.error.message, changeBlocked: true });
      return;
    }
    const { page, message, selectedBox, boxes } = this.state;
    const wasUnread = page?.messages.some(row => row.id === id && !row.read) === true;
    const updateBox = (candidate: Mailbox) => wasUnread && mailboxKey(candidate) === mailboxKey(box)
      ? { ...candidate, unread: Math.max(0, candidate.unread - 1) } : candidate;
    // The native change API confirms readStatus before acknowledging. Publish it
    // without reloading the list/body or resetting image consent and scroll state.
    this.update({ changing: false,
      page: page ? { ...page, messages: page.messages.map(row => row.id === id ? { ...row, read: true } : row) } : page,
      message: message?.id === id ? { ...message, read: true } : message,
      boxes: boxes.map(updateBox), selectedBox: selectedBox ? updateBox(selectedBox) : null });
  }
  async loadMore() {
    const { selectedBox, page, loadingBoxes, loadingPage, loadingMore, changing } = this.state;
    if (!selectedBox || page?.nextOffset == null || loadingBoxes || loadingPage || loadingMore || changing) return;
    const version = ++this.pageVersion;
    this.update({ loadingMore: true, moreError: null });
    const result = await this.request(() => this.api.list(selectedBox, page.nextOffset!));
    if (version !== this.pageVersion) return;
    if (!result.ok) { this.update({ loadingMore: false, moreError: result.error.message }); return; }
    const currentPage = this.state.page ?? page;
    const previous = new Map(page.messages.map(message => [message.id, message]));
    const messages = new Map(currentPage.messages.map(message => [message.id, message]));
    for (const message of result.value.messages) {
      // A read acknowledgement can arrive while the next page is in flight.
      const current = messages.get(message.id);
      messages.set(message.id, current && current !== previous.get(message.id) ? current : message);
    }
    this.update({ loadingMore: false, page: { ...page, messages: [...messages.values()], nextOffset: result.value.nextOffset } });
  }
  async change(input: MailChange) {
    const { selectedBox, message, page } = this.state;
    const related = this.state.conversation?.messages.some(entry => mailTargetKey(entry.target) === mailTargetKey(input.target)) === true;
    if (this.state.changing || this.state.loadingBoxes || this.state.changeBlocked || !selectedBox || !message
      || (!related && (message.id !== input.target.id || mailboxKey(selectedBox) !== mailboxKey(input.target.mailbox)))) return;
    const changesAnchor = input.target.id === message.id && mailboxKey(input.target.mailbox) === mailboxKey(selectedBox);
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
    if (!changesAnchor || input.action !== 'move') await this.loadMessage(message.id, false);
    const boxes = await this.request(() => this.api.mailboxes());
    if (boxes.ok) this.update({ boxes: boxes.value });
  }
}
