import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, StrictMode, type ReactNode } from 'react';
import { MailBrowser } from '../frontend/src/features/mail/MailView';
import { MAIL_ERRORS, mailFailure } from '../shared/apple-mail';
import { createMailDeferred, mailApiFixture, mailMessageFixture, mailSuccess, mailBox } from './apple-mail-fixtures';
import { mailComposer } from '../frontend/src/features/mail/mailComposer';
import type { Mailbox, MailChange, MailPage, MailReply, MailSend } from '../shared/apple-mail';

async function withMailDOM(run: (render: (node: ReactNode) => Promise<void>, document: Document) => Promise<void>) {
  const window = new Window();
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

test('Mail preloads mailboxes and the first page without reading message bodies', async () => {
  let connections = 0;
  let reads = 0;
  const api = mailApiFixture({ mailboxes: async () => { connections++; return mailSuccess([
    { accountId: 'a', accountName: 'Personal', path: ['INBOX'], unread: 1 },
    { accountId: 'b', accountName: 'Work', path: ['INBOX'], unread: 0 },
  ]); }, read: async () => { reads++; return mailSuccess({ ...mailMessageFixture, body: '<img src="https://example.test/pixel"><script>alert(1)</script>' }); } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    expect(connections).toBe(1); expect(reads).toBe(0);
    expect(document.querySelector('[aria-label="메일함"]')?.textContent).toContain('Personal');
    expect(document.querySelector('[aria-label="메일함"]')?.textContent).toContain('Work');
    expect(document.querySelectorAll('[aria-label^="읽지 않음 "]')).toHaveLength(1);
    const row = document.querySelector<HTMLButtonElement>('[aria-label="메일 목록"] button[aria-pressed]')!;
    await act(async () => row.click());
    expect(reads).toBe(1);
    expect(document.querySelector('[aria-label="메일 본문"] pre')?.textContent).toContain('<script>alert(1)</script>');
    expect(document.querySelector('img, script, iframe')).toBeNull();
    const labels = [...document.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).not.toContain('보내기'); expect(labels).not.toContain('삭제');
    const otherBox = document.querySelectorAll<HTMLButtonElement>('[aria-label="메일함"] section button')[1]!;
    await act(async () => otherBox.click());
    expect(document.querySelector('[aria-label="메일 본문"] pre')).toBeNull();
  });
});

test('mailbox scrolling shares overlay dragging and activity tracking while preserving selection', async () => {
  const api = mailApiFixture();
  await withMailDOM(async (render, document) => {
    const scene = (active: boolean) => <MailBrowser api={api} active={active}
      sidebarTarget={document.getElementById('mail-sidebar')} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />;
    await render(scene(true));
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
    await render(<MailBrowser api={api} sidebarTarget={document.getElementById('mail-sidebar')}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    const messageRow = document.querySelector<HTMLButtonElement>('[aria-label="메일 목록"] button[aria-pressed]')!;
    await act(async () => messageRow.click());
    const body = document.querySelector('[aria-label="메일 본문"] pre')!;
    const retainedContent = () => {
      expect(document.querySelector('[aria-label="메일 목록"] button[aria-pressed]')).toBe(messageRow);
      expect(document.querySelector('[aria-label="메일 본문"] pre')).toBe(body);
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
    await act(async () => button(document, '메일 새로고침').click());
    await pointer('pointerdown', 10); await pointer('pointermove', 110); await pointer('pointerup', 110);
    expect(connections).toBe(2);
    await act(async () => boxes.resolve(mailSuccess([mailBox])));
    expect(lists).toBe(2);
    expect(viewport.querySelector('[role="status"]')).toBe(status);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    retainedContent();
    expect(button(document, '메일 새로고침').disabled).toBe(true);
    await act(async () => page.resolve(mailSuccess({ messages: [mailMessageFixture], offset: 0, nextOffset: null })));
    expect(viewport.querySelector('[role="status"]')).toBeNull();
    expect(button(document, '메일 새로고침').disabled).toBe(false);
    retainedContent();
    await act(async () => button(document, '메일 새로고침').click());
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
      sidebarTarget={document.getElementById('mail-sidebar')} onOpen={() => { opens++; }}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} /></StrictMode>;
    await render(scene(false));
    expect(connections).toBe(1);
    expect(lists).toBe(1);
    expect(reads).toBe(0);
    const main = document.querySelector('main')!;
    expect(main.hidden).toBe(true);
    expect(main.querySelector('[aria-label="메일함"]')).toBeNull();
    const mailbox = document.querySelector<HTMLButtonElement>('#mail-sidebar button[aria-current="page"]')!;
    expect(mailbox).not.toBeNull();
    await act(async () => mailbox.click());
    expect(opens).toBe(1);
    expect(lists).toBe(1);
    await render(scene(true));
    expect(main.hidden).toBe(false);
    const row = document.querySelector<HTMLButtonElement>('[aria-label="메일 목록"] button[aria-pressed]')!;
    await act(async () => row.click());
    expect(reads).toBe(1);
    await act(async () => button(document, '새 메일 작성').click());
    await act(async () => mailComposer(api).edit({ subject: 'Keep this draft', body: 'Do not reset' }));
    await act(async () => button(document, '내용 유지하고 닫기').click());
    await render(scene(false));
    await render(scene(true));
    expect(document.querySelector('[aria-label="메일 목록"] button[aria-pressed]')).toBe(row);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[aria-label="메일 본문"] pre')?.textContent).toBe(mailMessageFixture.body);
    expect(connections).toBe(1);
    expect(lists).toBe(1);
    expect(reads).toBe(1);
    await act(async () => button(document, '작성 중인 메일').click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="메일 제목"]')?.value).toBe('Keep this draft');
  });
});

test('Mail shows retrieval failures separately from an empty mailbox and can recover', async () => {
  let fail = true;
  const api = mailApiFixture({ list: async () => fail ? mailFailure('invalid-response')
    : mailSuccess({ messages: [], offset: 0, nextOffset: null }) });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS['invalid-response']);
    expect(document.body.textContent).not.toContain('메일이 없습니다.');
    fail = false;
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '다시 시도')!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('메일이 없습니다.');
  });
});

test('Mail keeps its header usable through connection, permission failure and successful retry', async () => {
  const pending = createMailDeferred<MailReply<Mailbox[]>>();
  let connections = 0;
  let toggles = 0;
  const api = mailApiFixture({ mailboxes: () => {
    connections++;
    return connections === 1 ? pending.promise : Promise.resolve(mailSuccess([mailBox]));
  } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} rightSidebarOpen={false} onToggleRightSidebar={() => { toggles++; }} />);
    const header = document.querySelector('header')!;
    expect(header.textContent).toContain('MAIL');
    expect(button(document, '새 메일 작성').disabled).toBe(true);
    expect(button(document, '메일 새로고침').disabled).toBe(true);
    expect(connections).toBe(1);
    const connect = button(document, 'Connecting…');
    expect(connect.disabled).toBe(true);
    expect(connect.textContent).toBe('Connecting…');
    await act(async () => connect.click());
    expect(connections).toBe(1);
    await act(async () => button(document, 'Open right sidebar').click());
    expect(toggles).toBe(1);
    await act(async () => pending.resolve(mailFailure('permission')));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS.permission);
    expect(document.querySelector('[aria-label="메일 목록"]')).toBeNull();
    expect(connect.disabled).toBe(false);
    await act(async () => connect.click());
    expect(connections).toBe(2);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[aria-label="메일 목록"]')).not.toBeNull();
    expect(document.querySelector('header')).toBe(header);
    expect(connect.isConnected).toBe(false);
    expect(button(document, '새 메일 작성').disabled).toBe(false);
    expect(button(document, '메일 새로고침').disabled).toBe(false);
    await act(async () => button(document, '메일 새로고침').click());
    expect(connections).toBe(3);
  });
});

function button(document: Document, label: string) {
  const found = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

test('composer shows sender, cc and bcc review and requires an explicit second click to send', async () => {
  const sends: MailSend[] = [];
  const api = mailApiFixture({ send: async input => { sends.push(input); return mailSuccess({ operationId: input.operationId, accepted: true }); } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => button(document, '새 메일 작성').click());
    await act(async () => mailComposer(api).edit({ to: 'friend@example.test', cc: 'cc@example.test', bcc: 'private@example.test', body: 'Hello', subject: 'Review me' }));
    expect(document.querySelector<HTMLInputElement>('[aria-label="메일 제목"]')?.value).toBe('Review me');
    await act(async () => button(document, '보내기').click());
    expect(sends).toHaveLength(0);
    const review = document.querySelector('[aria-label="발송 전 확인"]');
    expect(review?.textContent).toContain('me@example.test'); expect(review?.textContent).toContain('private@example.test');
    expect(review?.textContent).toContain('Hello');
    await act(async () => button(document, '확인하고 보내기').click());
    expect(sends).toHaveLength(1); expect(document.querySelector('dialog')).toBeNull();
    expect(document.body.textContent).toContain('Mail에 발송을 요청했습니다');
  });
});

test('failed sends preserve displayed text after closing and reopening the composer', async () => {
  const api = mailApiFixture({ send: async () => mailFailure('send-unknown') });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => button(document, '새 메일 작성').click());
    await act(async () => mailComposer(api).edit({ to: 'friend@example.test', body: 'Retain this text' }));
    await act(async () => button(document, '보내기').click());
    await act(async () => button(document, '확인하고 보내기').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS['send-unknown']);
    expect(button(document, '보내기').disabled).toBe(true);
    await act(async () => button(document, '내용 유지하고 닫기').click());
    await act(async () => button(document, '작성 중인 메일').click());
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="작성 본문"]')?.value).toBe('Retain this text');
    expect(button(document, '보내기').disabled).toBe(true);
  });
});

test('trash action requires a destination confirmation and reply-all opens a draft without sending', async () => {
  const changes: MailChange[] = [];
  const api = mailApiFixture({ mailboxes: async () => mailSuccess([mailBox, { ...mailBox, path: ['Trash'] }]),
    change: async input => { changes.push(input); return mailSuccess(input.target); } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser sidebarTarget={document.getElementById('mail-sidebar')} api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="메일 목록"] button[aria-pressed]')!.click());
    expect(document.body.textContent).toContain('받는 사람: me@example.test');
    await act(async () => button(document, '전체 답장').click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="받는 사람"]')?.value).toBe('sender@example.test');
    expect(mailComposer(api).getSnapshot().reply?.all).toBe(true);
    await act(async () => button(document, '내용 유지하고 닫기').click());
    await act(async () => button(document, '휴지통으로 이동').click());
    expect(changes).toEqual([]);
    await act(async () => button(document, '이동 확인').click());
    expect(changes).toEqual([{ action: 'move', target: { mailbox: mailBox, id: 1 }, destination: { ...mailBox, path: ['Trash'] } }]);
  });
});
