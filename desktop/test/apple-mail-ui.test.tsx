import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, StrictMode, type ReactNode } from 'react';
import { MailBrowser } from '../frontend/src/features/mail/MailView';
import { MAIL_ERRORS, mailFailure } from '../shared/apple-mail';
import { createMailDeferred, mailApiFixture, mailMessageFixture, mailSuccess, mailBox } from './apple-mail-fixtures';
import { mailComposer } from '../frontend/src/features/mail/mailComposer';
import type { Mailbox, MailChange, MailPage, MailReply, MailSend } from '../shared/apple-mail';
import type { MailConversation } from '../shared/mail-conversation';

async function withMailDOM(run: (render: (node: ReactNode) => Promise<void>, document: Document) => Promise<void>) {
  const window = new Window();
  // DOMPurify uses Node.prototype's native getter. Happy DOM's base getter
  // returns an empty name instead of dispatching to Element/Text as Chromium does.
  Object.defineProperty(window.Node.prototype, 'nodeName', { configurable: true, get(this: Node) {
    return (this as Element).tagName ?? ({ 3: '#text', 8: '#comment', 9: '#document', 10: 'html', 11: '#document-fragment' } as Record<number, string>)[this.nodeType] ?? '';
  } });
  const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    ResizeObserver: window.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = globalThis.document.createElement('div');
  globalThis.document.body.append(container);
  const sidebar = globalThis.document.createElement('aside');
  sidebar.id = 'mail-sidebar';
  globalThis.document.body.append(sidebar);
  const root = createRoot(container);
  try { await run(async node => { await act(async () => root.render(node)); }, globalThis.document); }
  finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

async function expandMailAccount(document: Document, name = 'Personal') {
  const toggle = [...document.querySelectorAll<HTMLButtonElement>('#mail-sidebar button[aria-expanded]')]
    .find(button => button.textContent === name)!;
  if (toggle.getAttribute('aria-expanded') === 'false') await act(async () => toggle.click());
}

test('Mail preloads mailboxes and the first page without reading message bodies', async () => {
  let connections = 0;
  let reads = 0;
  const api = mailApiFixture({ mailboxes: async () => { connections++; return mailSuccess([
    { accountId: 'a', accountName: 'Personal', path: ['INBOX'], unread: 1 },
    { accountId: 'b', accountName: 'Work', path: ['INBOX'], unread: 0 },
  ]); }, read: async () => { reads++; return mailSuccess({ ...mailMessageFixture, body: '<img src="https://example.test/pixel"><script>alert(1)</script>' }); } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} />);
    expect(connections).toBe(1); expect(reads).toBe(0);
    expect(document.querySelector('[aria-label="Mailboxes"]')?.textContent).toContain('Personal');
    expect(document.querySelector('[aria-label="Mailboxes"]')?.textContent).toContain('Work');
    await expandMailAccount(document);
    expect(document.querySelectorAll('[aria-label$=" unread messages"]')).toHaveLength(1);
    const row = document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!;
    await act(async () => row.click());
    expect(reads).toBe(1);
    expect(document.querySelector('[aria-label="Message body"] pre')?.textContent).toContain('<script>alert(1)</script>');
    expect(document.querySelector('img, script, iframe')).toBeNull();
    const labels = [...document.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).not.toContain('Send'); expect(labels).not.toContain('Delete');
    await expandMailAccount(document, 'Work');
    const otherBox = document.querySelector<HTMLButtonElement>('[aria-label="Work mailboxes"] button')!;
    await act(async () => otherBox.click());
    expect(document.querySelector('[aria-label="Message body"] pre')).toBeNull();
  });
});

test('Mail close remains available while connection is pending or fails', async () => {
  const pending = createMailDeferred<MailReply<Mailbox[]>>();
  const api = mailApiFixture({ mailboxes: () => pending.promise });
  let closes = 0;
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} onClose={() => { closes++; }} />);
    expect(button(document, 'Reply').disabled).toBe(true);
    expect(button(document, 'Close mail').disabled).toBe(false);
    await act(async () => button(document, 'Close mail').click());
    expect(closes).toBe(1);
    await act(async () => pending.resolve(mailFailure('permission')));
    await act(async () => button(document, 'Close mail').click());
    expect(closes).toBe(2);
  });
});

test('Mail close preserves selected mail and an inline reply when reopened', async () => {
  const api = mailApiFixture();
  let active = true;
  await withMailDOM(async (render, document) => {
    const scene = () => <MailBrowser api={api} active={active} onClose={() => { active = false; }} />;
    await render(scene());
    const row = document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!;
    await act(async () => row.click());
    const actionLabels = [...document.querySelectorAll('[aria-label="Mail actions"] button')]
      .map(control => control.getAttribute('aria-label'));
    expect(actionLabels).toEqual(['Reply', 'Reply all', 'Move to Trash', 'Close mail']);
    await act(async () => button(document, 'Reply').click());
    await act(async () => mailComposer(api).edit({ body: 'Keep this reply' }));
    const originalForm = mailComposer(api).getSnapshot().form;
    await act(async () => button(document, 'Close mail').click());
    await render(scene());
    expect(document.querySelector('main')?.hidden).toBe(true);
    active = true;
    await render(scene());
    expect(document.querySelector('main')?.hidden).toBe(false);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(mailComposer(api).getSnapshot().form).toBe(originalForm);
    expect(mailComposer(api).getSnapshot().form?.body).toBe('Keep this reply');
    expect(document.querySelector('section[aria-label="Reply"]')).not.toBeNull();
  });
});

test('account accordions start closed, retain closing rows and preserve selection across toggles and refresh', async () => {
  let connections = 0;
  let lists = 0;
  const work = { ...mailBox, accountId: 'work', accountName: 'Work' };
  const api = mailApiFixture({
    mailboxes: async () => { connections++; return mailSuccess([mailBox, work]); },
    list: async () => { lists++; return mailSuccess({ messages: [mailMessageFixture], offset: 0, nextOffset: null }); },
  });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} sidebarTarget={document.getElementById('mail-sidebar')} />);
    const toggles = [...document.querySelectorAll<HTMLButtonElement>('#mail-sidebar button[aria-expanded]')];
    expect(toggles.map(toggle => toggle.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    expect(document.querySelector('[aria-label="Personal mailboxes"]')).toBeNull();
    expect(lists).toBe(1);
    await expandMailAccount(document);
    const region = document.querySelector('[aria-label="Personal mailboxes"]')!;
    const row = region.querySelector('[aria-current="page"]')!;
    const reveal = region.parentElement!;
    expect(toggles[0]!.getAttribute('aria-controls')).toBe(region.id);
    await act(async () => toggles[0]!.click());
    expect(reveal.getAttribute('data-expanded')).toBe('false');
    expect(reveal.hasAttribute('inert')).toBe(true);
    expect(reveal.getAttribute('aria-hidden')).toBe('true');
    expect(region.querySelector('[aria-current="page"]')).toBe(row);
    await expandMailAccount(document);
    expect(region.parentElement).toBe(reveal);
    expect(reveal.hasAttribute('inert')).toBe(false);
    await expandMailAccount(document, 'Work');
    expect(toggles.map(toggle => toggle.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    await act(async () => {
      const event = new document.defaultView!.Event('transitionend', { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: 'grid-template-rows' });
      reveal.dispatchEvent(event);
    });
    expect(document.querySelector('[aria-label="Personal mailboxes"]')).toBeNull();
    expect(connections).toBe(1);
    expect(lists).toBe(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Work mailboxes"] button')!.click());
    expect(lists).toBe(2);
    await act(async () => button(document, 'Refresh mail').click());
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[aria-label="Work mailboxes"] [aria-current="page"]')).not.toBeNull();
    expect(connections).toBe(2);
  });
});

test('mailbox scrolling shares overlay dragging and activity tracking while preserving selection', async () => {
  const api = mailApiFixture();
  await withMailDOM(async (render, document) => {
    const scene = (active: boolean) => <MailBrowser api={api} active={active}
      sidebarTarget={document.getElementById('mail-sidebar')} />;
    await render(scene(true));
    await expandMailAccount(document);
    const viewport = document.querySelector<HTMLElement>('[role="region"][aria-label="Mailboxes"]')!;
    expect(viewport).not.toBeNull();
    const surface = viewport.parentElement!;
    const scrollbar = surface.querySelector<HTMLElement>(':scope > [aria-hidden="true"]')!;
    expect(surface.dataset.autoHideScrollbars).toBe('true');
    expect(scrollbar.dataset.scrollbarActive).toBeUndefined();
    const selected = viewport.querySelector('[aria-current="page"]');
    expect(selected?.textContent).toContain('INBOX');
    const Event = document.defaultView!.Event;
    viewport.scrollTop = 120;
    viewport.dispatchEvent(new Event('scroll'));
    expect(scrollbar.scrollTop).toBe(120);
    // Native scrollTop writes generate this event in Chromium.
    scrollbar.dispatchEvent(new Event('scroll'));
    expect(scrollbar.dataset.scrollbarActive).toBe('true');
    scrollbar.scrollTop = 240;
    scrollbar.dispatchEvent(new Event('scroll'));
    expect(viewport.scrollTop).toBe(240);
    await render(scene(false));
    await render(scene(true));
    expect(document.querySelector('[role="region"][aria-label="Mailboxes"]')).toBe(viewport);
    expect(viewport.scrollTop).toBe(240);
    expect(viewport.querySelector('[aria-current="page"]')).toBe(selected);
  });
});

test('Mail pull refresh waits for mailboxes and messages without duplicate loading or requests', async () => {
  const boxes = createMailDeferred<MailReply<Mailbox[]>>();
  const page = createMailDeferred<MailReply<MailPage>>();
  let connections = 0;
  let lists = 0;
  const api = mailApiFixture({
    mailboxes: async () => ++connections === 1 ? mailSuccess([mailBox]) : boxes.promise,
    list: async () => ++lists === 1 ? mailSuccess({ messages: [mailMessageFixture], offset: 0, nextOffset: null }) : page.promise,
  });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} sidebarTarget={document.getElementById('mail-sidebar')} />);
    await expandMailAccount(document);
    const messageRow = document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!;
    await act(async () => messageRow.click());
    const body = document.querySelector('[aria-label="Message body"] pre')!;
    const retainedContent = () => {
      expect(document.querySelector('[aria-label="Message list"] button[aria-pressed]')).toBe(messageRow);
      expect(document.querySelector('[aria-label="Message body"] pre')).toBe(body);
      expect(body.textContent).toBe(mailMessageFixture.body);
      expect(messageRow.getAttribute('aria-pressed')).toBe('true');
    };
    const viewport = document.querySelector<HTMLElement>('[role="region"][aria-label="Mailboxes"]')!;
    const row = viewport.querySelector('[aria-current="page"]')!;
    const view = document.defaultView!;
    const pointer = async (type: string, y: number) => {
      await act(async () => {
        const event = new view.PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
          clientX: 10, clientY: y, button: 0, bubbles: true, cancelable: true });
        (type === 'pointerdown' ? row : view).dispatchEvent(event);
      });
    };
    viewport.scrollTop = 100;
    await pointer('pointerdown', 10); await pointer('pointermove', 110); await pointer('pointerup', 110);
    expect(connections).toBe(1);
    viewport.scrollTop = 0;
    await pointer('pointerdown', 10); await pointer('pointermove', 30); await pointer('pointerup', 30);
    expect(connections).toBe(1);
    await pointer('pointerdown', 10); await pointer('pointermove', 110);
    const status = viewport.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.style.height).toBe('36px');
    await pointer('pointerup', 110);
    expect(connections).toBe(2);
    expect(viewport.querySelector('[aria-current="page"]')).toBe(row);
    expect(viewport.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(viewport.querySelector('[role="status"]')).toBe(status);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(row.hasAttribute('disabled')).toBe(false);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    retainedContent();
    await act(async () => button(document, 'Refresh mail').click());
    await pointer('pointerdown', 10); await pointer('pointermove', 110); await pointer('pointerup', 110);
    expect(connections).toBe(2);
    await act(async () => boxes.resolve(mailSuccess([mailBox])));
    expect(lists).toBe(2);
    expect(viewport.querySelector('[role="status"]')).toBe(status);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    retainedContent();
    expect(button(document, 'Refresh mail').disabled).toBe(true);
    await act(async () => page.resolve(mailSuccess({ messages: [mailMessageFixture], offset: 0, nextOffset: null })));
    expect(viewport.querySelector('[role="status"]')).toBeNull();
    expect(button(document, 'Refresh mail').disabled).toBe(false);
    retainedContent();
    await act(async () => button(document, 'Refresh mail').click());
    expect(connections).toBe(3);
  });
});

test('hidden Mail preloads once in Strict Mode and preserves its page, body and draft across tab changes', async () => {
  let connections = 0;
  let lists = 0;
  let reads = 0;
  let opens = 0;
  const api = mailApiFixture({
    mailboxes: async () => { connections++; return mailSuccess([mailBox]); },
    list: async () => { lists++; return mailSuccess({ messages: [mailMessageFixture], offset: 0, nextOffset: null }); },
    read: async () => { reads++; return mailSuccess(mailMessageFixture); },
  });
  await withMailDOM(async (render, document) => {
    const scene = (active: boolean) => <StrictMode><MailBrowser api={api} active={active}
      sidebarTarget={document.getElementById('mail-sidebar')} onOpen={() => { opens++; }} /></StrictMode>;
    await render(scene(false));
    expect(connections).toBe(1);
    expect(lists).toBe(1);
    expect(reads).toBe(0);
    const main = document.querySelector('main')!;
    expect(main.hidden).toBe(true);
    expect(main.querySelector('[aria-label="Mailboxes"]')).toBeNull();
    await expandMailAccount(document);
    const mailbox = document.querySelector<HTMLButtonElement>('#mail-sidebar button[aria-current="page"]')!;
    expect(mailbox).not.toBeNull();
    await act(async () => mailbox.click());
    expect(opens).toBe(1);
    expect(lists).toBe(1);
    await render(scene(true));
    expect(main.hidden).toBe(false);
    const row = document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!;
    await act(async () => row.click());
    expect(reads).toBe(1);
    await act(async () => button(document, 'Compose mail').click());
    await act(async () => mailComposer(api).edit({ subject: 'Keep this draft', body: 'Do not reset' }));
    await act(async () => button(document, 'Close and keep draft').click());
    await render(scene(false));
    await render(scene(true));
    expect(document.querySelector('[aria-label="Message list"] button[aria-pressed]')).toBe(row);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[aria-label="Message body"] pre')?.textContent).toBe(mailMessageFixture.body);
    expect(connections).toBe(1);
    expect(lists).toBe(1);
    expect(reads).toBe(1);
    await act(async () => button(document, 'Resume draft').click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="Message subject"]')?.value).toBe('Keep this draft');
  });
});

test('infinite mail loading appends on intersection, preserves content, retries failures and stops when hidden or complete', async () => {
  const pending = createMailDeferred<MailReply<MailPage>>();
  const offsets: number[] = [];
  let additionalRequests = 0;
  const api = mailApiFixture({ list: async (_box, offset = 0) => {
    offsets.push(offset);
    if (offset === 25 && ++additionalRequests === 1) return pending.promise;
    return mailSuccess({ offset, nextOffset: offset < 50 ? offset + 25 : null,
      messages: Array.from({ length: offset === 50 ? 1 : 25 }, (_, index) => ({ ...mailMessageFixture, id: offset + index + 1 })) });
  } });
  await withMailDOM(async (render, document) => {
    const observers = new Set<() => void>();
    const observedRoots: Element[] = [];
    Object.defineProperty(document.defaultView!, 'IntersectionObserver', { configurable: true, value: class {
      private readonly notify: () => void;
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void, options: { root: Element }) {
        observedRoots.push(options.root);
        this.notify = () => callback([{ isIntersecting: true }]);
      }
      observe() { observers.add(this.notify); }
      disconnect() { observers.delete(this.notify); }
    } });
    const scene = (active: boolean) => <MailBrowser api={api} active={active}
      sidebarTarget={document.getElementById('mail-sidebar')} />;
    const intersect = async () => { await act(async () => { for (const notify of [...observers]) notify(); }); };
    const rows = () => document.querySelectorAll<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]');
    await render(scene(false));
    expect(observers.size).toBe(0);
    expect(rows()).toHaveLength(25);
    await render(scene(true));
    expect(observers.size).toBe(1);
    const first = rows()[0]!;
    const viewport = first.parentElement!;
    expect(observedRoots.at(-1)).toBe(viewport);
    viewport.scrollTop = 100;
    await act(async () => first.click());
    const body = document.querySelector('[aria-label="Message body"] pre')!;
    await intersect();
    await intersect();
    expect(offsets).toEqual([0, 25]);
    expect(rows()).toHaveLength(25);
    expect(rows()[0]).toBe(first);
    expect(document.querySelector('[aria-label="Loading more messages…"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Message body"] pre')).toBe(body);
    await act(async () => pending.resolve(mailFailure('unavailable')));
    await intersect();
    expect(offsets).toEqual([0, 25]);
    expect(observers.size).toBe(0);
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry loading more')!.click());
    expect(rows()).toHaveLength(50);
    expect(rows()[0]).toBe(first);
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[aria-label="Message body"] pre')).toBe(body);
    expect(viewport.scrollTop).toBe(100);
    await render(scene(false));
    await intersect();
    expect(offsets).toEqual([0, 25, 25]);
    await render(scene(true));
    await intersect();
    expect(rows()).toHaveLength(51);
    expect(offsets).toEqual([0, 25, 25, 50]);
    expect(observers.size).toBe(0);
    expect(document.querySelector('[aria-label="Previous mail page"], [aria-label="Next mail page"]')).toBeNull();
    expect(document.querySelector('[aria-label="Loading more messages…"]')).toBeNull();
  });
});

test('Mail shows retrieval failures separately from an empty mailbox and can recover', async () => {
  let fail = true;
  const api = mailApiFixture({ list: async () => fail ? mailFailure('invalid-response')
    : mailSuccess({ messages: [], offset: 0, nextOffset: null }) });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS['invalid-response']);
    expect(document.body.textContent).not.toContain('No messages.');
    fail = false;
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('No messages.');
    expect(document.querySelector('[aria-label="Message body"]')?.textContent).toContain('Select a message to view its content.');
  });
});

test('Mail keeps sidebar actions available through connection, permission failure and successful retry', async () => {
  const pending = createMailDeferred<MailReply<Mailbox[]>>();
  let connections = 0;
  const api = mailApiFixture({ mailboxes: () => {
    connections++;
    return connections === 1 ? pending.promise : Promise.resolve(mailSuccess([mailBox]));
  } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} />);
    expect(button(document, 'Compose mail').disabled).toBe(true);
    expect(button(document, 'Refresh mail').disabled).toBe(true);
    expect(connections).toBe(1);
    const connect = button(document, 'Connecting…');
    expect(connect.disabled).toBe(true);
    expect(connect.textContent).toBe('Connecting…');
    await act(async () => connect.click());
    expect(connections).toBe(1);
    await act(async () => pending.resolve(mailFailure('permission')));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS.permission);
    expect(document.querySelector('[aria-label="Message list"]')).toBeNull();
    expect(connect.disabled).toBe(false);
    await act(async () => connect.click());
    expect(connections).toBe(2);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[aria-label="Message list"]')).not.toBeNull();
    expect(connect.isConnected).toBe(false);
    expect(button(document, 'Compose mail').disabled).toBe(false);
    expect(button(document, 'Refresh mail').disabled).toBe(false);
    await act(async () => button(document, 'Refresh mail').click());
    expect(connections).toBe(3);
  });
});

function button(document: Document, label: string) {
  const found = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

test('one Send click polishes and sends with the chosen sender, cc and bcc', async () => {
  const sends: MailSend[] = [];
  const api = mailApiFixture({ send: async input => { sends.push(input); return mailSuccess({ operationId: input.operationId, accepted: true }); } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} />);
    await act(async () => button(document, 'Compose mail').click());
    await act(async () => mailComposer(api).edit({ to: 'friend@example.test', cc: 'cc@example.test', bcc: 'private@example.test', body: 'Hello', subject: 'Review me' }));
    expect(document.querySelector<HTMLInputElement>('[aria-label="Message subject"]')?.value).toBe('Review me');
    await act(async () => button(document, 'Send').click());
    expect(sends[0]?.sender).toBe('me@example.test');
    expect(sends[0]?.bcc).toEqual(['private@example.test']);
    expect(sends).toHaveLength(1); expect(document.querySelector('dialog')).toBeNull();
    expect(document.body.textContent).toContain('Mail has been asked to send your message');
    await act(async () => button(document, 'Dismiss send notification').click());
    expect(document.body.textContent).not.toContain('Mail has been asked to send your message');
    expect(document.querySelector('[aria-label="Dismiss send notification"]')).toBeNull();
    await render(null);
    await render(<MailBrowser api={api} />);
    expect(mailComposer(api).getSnapshot().notice).toBeNull();
    expect(document.body.textContent).not.toContain('Mail has been asked to send your message');
    expect(sends).toHaveLength(1);
  });
});

test('failed sends preserve displayed text after closing and reopening the composer', async () => {
  const api = mailApiFixture({ send: async () => mailFailure('send-unknown') });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} />);
    await act(async () => button(document, 'Compose mail').click());
    await act(async () => mailComposer(api).edit({ to: 'friend@example.test', body: 'Retain this text' }));
    await act(async () => button(document, 'Send').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS['send-unknown']);
    expect(button(document, 'Send').disabled).toBe(true);
    await act(async () => button(document, 'Close and keep draft').click());
    await act(async () => button(document, 'Resume draft').click());
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Compose message body"]')?.value).toBe('Retain this text');
    expect(button(document, 'Send').disabled).toBe(true);
  });
});

test('trash action requires a destination confirmation and reply-all opens a draft without sending', async () => {
  const changes: MailChange[] = [];
  const api = mailApiFixture({ mailboxes: async () => mailSuccess([mailBox, { ...mailBox, path: ['Trash'] }]),
    change: async input => { changes.push(input); return mailSuccess(input.target); } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!.click());
    expect(document.body.textContent).toContain('To: me@example.test');
    const automaticRead: MailChange = { action: 'read', target: { mailbox: mailBox, id: 1 }, value: true };
    expect(changes).toEqual([automaticRead]);
    expect(document.querySelector('[aria-label="Message list"] button[aria-pressed]')?.getAttribute('data-unread')).toBe('false');
    await act(async () => button(document, 'Reply all').click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="To"]')?.value).toBe('sender@example.test');
    expect(mailComposer(api).getSnapshot().reply?.all).toBe(true);
    await act(async () => button(document, 'Close and keep draft').click());
    await act(async () => button(document, 'Move to Trash').click());
    expect(changes).toEqual([automaticRead]);
    await act(async () => button(document, 'Confirm move').click());
    const readBox = { ...mailBox, unread: 0 };
    expect(changes).toEqual([automaticRead, { action: 'move', target: { mailbox: readBox, id: 1 },
      destination: { ...mailBox, path: ['Trash'] } }]);
  });
});

test('reply opens above the original inside the message pane and preserves draft identity across navigation', async () => {
  const sends: MailSend[] = [];
  const api = mailApiFixture({
    list: async () => mailSuccess({ offset: 0, nextOffset: null, messages: [mailMessageFixture, { ...mailMessageFixture, id: 2 }] }),
    read: async target => mailSuccess({ ...mailMessageFixture, id: target.id, body: `Original ${target.id}` }),
    send: async input => { sends.push(input); return mailSuccess({ operationId: input.operationId, accepted: true }); },
  });
  await withMailDOM(async (render, document) => {
    const scene = (active = true) => <MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api}
      active={active} />;
    await render(scene());
    const rows = () => document.querySelectorAll<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]');
    await act(async () => rows()[0]!.click());
    await act(async () => button(document, 'Reply').click());
    expect(document.querySelector('dialog')).toBeNull();
    const pane = document.querySelector('[aria-label="Message body"]')!;
    const editor = pane.querySelector<HTMLIFrameElement>('[title="Reply message editor"]')!;
    expect(editor.srcdoc).toContain('Original 1');
    expect(editor.srcdoc).toContain('blockquote');
    expect(document.querySelector<HTMLInputElement>('[aria-label="To"]')?.value).toBe('sender@example.test');
    await act(async () => mailComposer(api).edit({ body: 'Inline response', html: '<p>Inline response</p><blockquote>Original 1</blockquote>' }));
    await render(scene(false)); await render(scene());
    expect(mailComposer(api).getSnapshot().form?.body).toBe('Inline response');
    await act(async () => rows()[1]!.click());
    expect(document.querySelector('[title="Reply message editor"]')).toBeNull();
    expect(pane.textContent).toContain('Original 2');
    await act(async () => button(document, 'Resume draft').click());
    expect(pane.querySelector<HTMLIFrameElement>('iframe')?.srcdoc).toContain('Inline response');
    expect(mailComposer(api).getSnapshot().original?.body).toBe('Original 1');
    await act(async () => button(document, 'Send').click());
    expect(sends).toHaveLength(1);
    expect(sends[0]?.reply?.target.id).toBe(1);
    expect(sends[0]?.body).toContain('Inline response');
    expect(pane.querySelector('[aria-label="Original message"]')).toBeNull();
    expect(pane.textContent).toContain('Original 2');
    await act(async () => button(document, 'Dismiss send notification').click());
  });
});

test('inline reply keeps its source through account errors and preserves text after an uncertain send', async () => {
  let denied = true;
  let sends = 0;
  const api = mailApiFixture({
    accounts: async () => denied ? mailFailure('permission') : mailSuccess([{ id: 'account-a', name: 'Personal', addresses: ['me@example.test'] }]),
    send: async () => { sends++; return mailFailure('send-unknown'); },
  });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!.click());
    await act(async () => button(document, 'Reply all').click());
    expect(document.querySelector('dialog')).toBeNull();
    expect(mailComposer(api).getSnapshot().original?.body).toBe(mailMessageFixture.body);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS.permission);
    denied = false;
    await act(async () => button(document, 'Retry sending accounts').click());
    await act(async () => mailComposer(api).edit({ body: 'Do not lose this reply', html: '<p>Do not lose this reply</p><blockquote>Original</blockquote>' }));
    await act(async () => button(document, 'Send').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS['send-unknown']);
    await act(async () => button(document, 'Close reply').click());
    await act(async () => button(document, 'Resume draft').click());
    expect(mailComposer(api).getSnapshot().form?.body).toBe('Do not lose this reply');
    expect(button(document, 'Send').disabled).toBe(true);
    expect(sends).toBe(1);
    await act(async () => button(document, 'Discard draft').click());
    await act(async () => button(document, 'Keep editing').click());
    expect(document.querySelector('[title="Reply message editor"]') !== null).toBe(true);
    await act(async () => button(document, 'Discard draft').click());
    await act(async () => button(document, 'Discard').click());
    expect(document.querySelector('[title="Reply message editor"]')).toBeNull();
    expect(mailComposer(api).getSnapshot().original).toBeNull();
  });
});

test('conversation shows received and sent bodies with isolated image consent and exact reply targets', async () => {
  const sentBox = { ...mailBox, path: ['Sent'], unread: 0 };
  const original = { ...mailMessageFixture, read: true, html: '<p>Original</p><img src="https://example.test/original.png">' };
  const reply = { ...mailMessageFixture, id: 2, subject: 'Re: Hello', body: 'Sent reply',
    html: '<p>Reply</p><img src="https://example.test/reply.png">', date: '2026-09-23T01:00:00Z' };
  const changes: MailChange[] = [];
  const api = mailApiFixture({
    mailboxes: async () => mailSuccess([mailBox, sentBox]),
    read: async target => mailSuccess(target.id === 1 ? original : reply),
    change: async input => { changes.push(input); return mailSuccess(input.target); },
    conversation: async target => mailSuccess({ incomplete: false, messages: [
      { target, summary: original }, { target: { mailbox: sentBox, id: 2 }, summary: reply },
    ] }),
  });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} onClose={() => {}} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!.click());
    const conversation = document.querySelector('[aria-label="Mail conversation"]')!;
    expect(conversation).not.toBeNull();
    expect(conversation.querySelectorAll('iframe')).toHaveLength(0);
    expect(conversation.querySelectorAll('[aria-label="HTML message content"]')).toHaveLength(2);
    expect(conversation.querySelectorAll('section')[0]?.getAttribute('aria-label')).toBe('Selected message');
    expect(changes).toHaveLength(0);
    const related = document.querySelector('[aria-label="Related message: Re: Hello"]')!;
    const load = [...related.querySelectorAll<HTMLButtonElement>('button')].find(control => control.textContent === 'Load images')!;
    await act(async () => load.click());
    expect(related.querySelector('[aria-label="HTML message content"]')?.shadowRoot?.innerHTML).toContain('src="https://example.test/reply.png"');
    expect(document.querySelector('[aria-label="Selected message"] [aria-label="HTML message content"]')?.shadowRoot?.innerHTML).not.toContain('src="https://example.test/original.png"');
    expect(document.querySelectorAll('[aria-label="Close mail"]')).toHaveLength(1);
    await act(async () => related.querySelector<HTMLButtonElement>('[aria-label="Reply all"]')!.click());
    expect(mailComposer(api).getSnapshot().reply).toEqual({ target: { mailbox: sentBox, id: 2 }, all: true });
    expect(mailComposer(api).getSnapshot().remoteImagesAllowed).toBe(true);
    expect(document.querySelector('[aria-label="Message list"] button[aria-pressed="true"]')).not.toBeNull();
  });
});

test('conversation failure preserves the selected body and retry recovers without another read mutation', async () => {
  let failed = true;
  const api = mailApiFixture({ conversation: async target => failed ? mailFailure('timeout')
    : mailSuccess({ incomplete: false, messages: [{ target, summary: mailMessageFixture }] }) });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!.click());
    expect(document.querySelector('[aria-label="Message body"] pre')?.textContent).toBe(mailMessageFixture.body);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load the conversation');
    failed = false;
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find(control => control.textContent === 'Retry conversation')!;
    await act(async () => retry.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[aria-label="Message body"] pre')?.textContent).toBe(mailMessageFixture.body);
  });
});


test('long conversations show every body together after discovery without expansion', async () => {
  const pending = createMailDeferred<MailReply<MailConversation>>();
  const sentBox = { ...mailBox, path: ['Sent'], unread: 0 };
  const messages = Array.from({ length: 7 }, (_, index) => ({ ...mailMessageFixture,
    id: index + 1, read: true, subject: `Conversation ${index + 1}`, body: `Body ${index + 1}` }));
  const reads: number[] = [];
  const api = mailApiFixture({
    list: async () => mailSuccess({ messages: [messages[0]!], offset: 0, nextOffset: null }),
    read: async target => { reads.push(target.id); return mailSuccess(messages[target.id - 1]!); },
    conversation: () => pending.promise,
  });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!.click());
    const pane = document.querySelector('[aria-label="Message body"]')!;
    expect(pane.querySelector('pre')).toBeNull();
    expect(pane.textContent).toContain('Loading message');
    expect(pane.getAttribute('aria-busy')).toBe('true');
    expect(pane.textContent).not.toContain('Looking for related messages');
    await act(async () => pending.resolve(mailSuccess({ incomplete: false,
      messages: messages.map((summary, index) => ({ summary, target: { id: summary.id, mailbox: index === 0 ? mailBox : sentBox } })) })));
    expect([...reads].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...pane.querySelectorAll('pre')].map(body => body.textContent)).toEqual(messages.map(message => message.body));
    expect(pane.getAttribute('aria-busy')).toBe('false');
    expect(pane.querySelector('button[aria-expanded]')).toBeNull();
    expect(pane.textContent).not.toContain('Selected message');
    expect(pane.textContent).not.toContain('Sent ·');
    const third = pane.querySelector('[aria-label="Related message: Conversation 3"]')!;
    await act(async () => third.querySelector<HTMLButtonElement>('[aria-label="Reply"]')!.click());
    expect(mailComposer(api).getSnapshot().reply?.target).toEqual({ mailbox: sentBox, id: 3 });
  });
});

test('one loading state spans the selected message and every related body', async () => {
  const first = createMailDeferred<MailReply<typeof mailMessageFixture>>();
  const second = createMailDeferred<MailReply<typeof mailMessageFixture>>();
  const third = createMailDeferred<MailReply<typeof mailMessageFixture>>();
  const original = { ...mailMessageFixture, read: true, body: 'Original body' };
  const api = mailApiFixture({
    read: target => target.id === 1 ? first.promise : target.id === 2 ? second.promise : third.promise,
    conversation: async target => mailSuccess({ incomplete: false, messages: [1, 2, 3].map(id => ({
      target: { ...target, id }, summary: { ...original, id, subject: `Message ${id}` },
    })) }),
  });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!.click());
    const pane = document.querySelector('[aria-label="Message body"]')!;
    const loader = pane.querySelector('[role="status"][aria-label="Loading message…"]');
    expect(loader).not.toBeNull();
    await act(async () => first.resolve(mailSuccess(original)));
    expect(pane.querySelector('[role="status"][aria-label="Loading message…"]')).toBe(loader);
    expect(pane.getAttribute('aria-busy')).toBe('true');
    expect(pane.textContent).not.toContain('Loading related message');
    expect(pane.querySelector('[aria-label="Mail conversation"]')).toBeNull();
    await act(async () => second.resolve(mailSuccess({ ...original, id: 2, body: 'Second body' })));
    expect(pane.querySelector('[role="status"][aria-label="Loading message…"]')).toBe(loader);
    expect(pane.querySelector('pre')).toBeNull();
    expect(pane.textContent).toContain('Loading message');
    expect(pane.querySelector('[aria-label="Mail conversation"]')).toBeNull();
    await act(async () => third.resolve(mailSuccess({ ...original, id: 3, body: 'Third body' })));
    expect([...pane.querySelectorAll('pre')].map(body => body.textContent)).toEqual(['Original body', 'Second body', 'Third body']);
    expect(pane.querySelectorAll('[aria-label^="Related message:"]')).toHaveLength(2);
    expect(pane.getAttribute('aria-busy')).toBe('false');
    expect(pane.querySelector('[role="status"][aria-label="Loading message…"]')).toBeNull();
    expect(pane.textContent).not.toContain('Loading related message');
  });
});

test('failed related bodies remain retryable while successfully loaded content stays visible', async () => {
  let failed = true;
  const original = { ...mailMessageFixture, read: true, body: 'Original body' };
  const api = mailApiFixture({
    read: async target => target.id === 2 && failed ? mailFailure('timeout')
      : mailSuccess({ ...original, id: target.id, body: `Body ${target.id}` }),
    conversation: async target => mailSuccess({ incomplete: false, messages: [1, 2, 3].map(id => ({
      target: { ...target, id }, summary: { ...original, id, subject: `Message ${id}` },
    })) }),
  });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Message list"] button[aria-pressed]')!.click());
    const pane = document.querySelector('[aria-label="Message body"]')!;
    expect([...pane.querySelectorAll('pre')].map(body => body.textContent)).toEqual(['Body 1', 'Body 3']);
    const failedCard = pane.querySelector('[aria-label="Related message: Message 2"]')!;
    expect(failedCard.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS.timeout);
    failed = false;
    const retry = [...failedCard.querySelectorAll<HTMLButtonElement>('button')].find(control => control.textContent === 'Retry related message')!;
    await act(async () => retry.click());
    expect([...pane.querySelectorAll('pre')].map(body => body.textContent)).toEqual(['Body 1', 'Body 2', 'Body 3']);
    expect(pane.querySelector('[role="alert"]')).toBeNull();
  });
});
