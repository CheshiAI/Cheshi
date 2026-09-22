import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { MailBrowser } from '../frontend/src/features/mail/MailView';
import { MAIL_ERRORS, mailFailure } from '../shared/apple-mail';
import { mailApiFixture, mailMessageFixture, mailSuccess, mailBox } from './apple-mail-fixtures';
import { mailComposer } from '../frontend/src/features/mail/mailComposer';
import type { MailChange, MailSend } from '../shared/apple-mail';

async function withMailDOM(run: (render: (node: ReactNode) => Promise<void>, document: Document) => Promise<void>) {
  const window = new Window();
  const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = globalThis.document.createElement('div');
  globalThis.document.body.append(container);
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

test('Mail connects only on request and renders selected messages as inert plain text', async () => {
  let connections = 0;
  let reads = 0;
  const api = mailApiFixture({ mailboxes: async () => { connections++; return mailSuccess([
    { accountId: 'a', accountName: 'Personal', path: ['INBOX'], unread: 1 },
    { accountId: 'b', accountName: 'Work', path: ['INBOX'], unread: 0 },
  ]); }, read: async () => { reads++; return mailSuccess({ ...mailMessageFixture, body: '<img src="https://example.test/pixel"><script>alert(1)</script>' }); } });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    expect(connections).toBe(0); expect(reads).toBe(0);
    const connect = [...document.querySelectorAll('button')].find(button => button.textContent === 'Apple Mail 연결')!;
    await act(async () => connect.click());
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
    const otherBox = document.querySelectorAll<HTMLButtonElement>('[aria-label="메일함"] button')[1]!;
    await act(async () => otherBox.click());
    expect(document.querySelector('[aria-label="메일 본문"] pre')).toBeNull();
  });
});

test('Mail shows retrieval failures separately from an empty mailbox and can recover', async () => {
  let fail = true;
  const api = mailApiFixture({ list: async () => fail ? mailFailure('invalid-response')
    : mailSuccess({ messages: [], offset: 0, nextOffset: null }) });
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Apple Mail 연결')!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS['invalid-response']);
    expect(document.body.textContent).not.toContain('메일이 없습니다.');
    fail = false;
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '다시 시도')!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('메일이 없습니다.');
  });
});

test('Mail permission denial keeps a reconnect action and does not show a false empty list', async () => {
  await withMailDOM(async (render, document) => {
    await render(<MailBrowser api={mailApiFixture({ mailboxes: async () => mailFailure('permission') })}
      rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Apple Mail 연결')!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(MAIL_ERRORS.permission);
    expect(document.querySelector('[aria-label="메일 목록"]')).toBeNull();
    expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Apple Mail 연결')?.disabled).toBe(false);
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
    await render(<MailBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => button(document, 'Apple Mail 연결').click());
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
    await render(<MailBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => button(document, 'Apple Mail 연결').click());
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
    await render(<MailBrowser api={api} rightSidebarOpen={false} onToggleRightSidebar={() => {}} />);
    await act(async () => button(document, 'Apple Mail 연결').click());
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
