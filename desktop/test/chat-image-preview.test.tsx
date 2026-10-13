import { expect, mock, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const thumbnail = 'data:image/png;base64,dGh1bWJuYWls';
const original = 'data:image/png;base64,b3JpZ2luYWw=';
const requests: string[] = [];
const desktop = {
  getCodexChatAttachmentPreview: async () => thumbnail,
  getCodexChatAttachmentImage: async (path: string): Promise<string | null> => { requests.push(path); return original; },
};
mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: desktop }));
const { ChatComposerAttachments } = await import('../frontend/src/features/chat/ChatComposerAttachments');
const { MessageContent } = await import('../frontend/src/features/chat/MessageContent');

async function withDOM(run: (h: { render(node: ReactNode): Promise<void>; click(selector: string): Promise<void> }) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const app = document.createElement('div'); app.id = 'app'; document.body.append(app);
  const root = createRoot(app);
  requests.length = 0;
  const loadImage = desktop.getCodexChatAttachmentImage;
  try {
    await run({
      render: async node => { await act(async () => root.render(node)); },
      click: async selector => {
        const button = document.querySelector<HTMLButtonElement>(selector);
        if (!button) throw new Error(`Missing button: ${selector}`);
        await act(async () => { button.focus(); button.click(); });
      },
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    desktop.getCodexChatAttachmentImage = loadImage;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const attachment = { kind: 'image' as const, name: 'photo.png', path: '/attachments/photo.png', previewUrl: thumbnail };
const trigger = 'button[aria-label="View image: photo.png"]';

test('composer opens the original without submitting or removing attachments, then restores focus', async () => {
  await withDOM(async h => {
    let removed = '', submitted = false;
    await h.render(<form onSubmit={event => { event.preventDefault(); submitted = true; }}>
      <input defaultValue="Keep this draft" />
      <ChatComposerAttachments attachments={[attachment]} removeAttachment={path => { removed = path; }} />
    </form>);
    expect(requests).toEqual([]);
    await h.click(trigger);
    expect(requests).toEqual([attachment.path]);
    expect(document.querySelector('dialog img')?.getAttribute('src')).toBe(original);
    expect(submitted).toBe(false);
    expect(removed).toBe('');
    await h.click('button[aria-label="Close dialog"]');
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(trigger));
    expect(document.querySelector('input')?.value).toBe('Keep this draft');
    await h.click('button[aria-label="Remove photo.png"]');
    expect(removed).toBe(attachment.path);
    expect(document.querySelector('dialog')).toBeNull();
  });
});

test('history uses the same original-image dialog and native Escape cancellation', async () => {
  await withDOM(async h => {
    await h.render(<MessageContent text={`Attached\n[Image: ${attachment.path}]`} renderLocalImages />);
    expect(requests).toEqual([]);
    await h.click(trigger);
    expect(document.querySelector('dialog img')?.getAttribute('src')).toBe(original);
    await act(async () => { document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(trigger));
  });
});

test('missing images and rejected reads remain dismissible', async () => {
  await withDOM(async h => {
    await h.render(<ChatComposerAttachments attachments={[attachment]} removeAttachment={() => {}} />);
    desktop.getCodexChatAttachmentImage = async () => null;
    await h.click(trigger);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('unavailable');
    await h.click('button[aria-label="Close dialog"]');
    desktop.getCodexChatAttachmentImage = async () => { throw new Error('read failed'); };
    await h.click(trigger);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Unable to load');
    await h.click('button[aria-label="Close dialog"]');
  });
});

test('closing a loading image discards its late result', async () => {
  await withDOM(async h => {
    let resolve!: (value: string) => void;
    desktop.getCodexChatAttachmentImage = () => new Promise<string>(done => { resolve = done; });
    await h.render(<ChatComposerAttachments attachments={[attachment]} removeAttachment={() => {}} />);
    await h.click(trigger);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading image');
    await h.click('button[aria-label="Close dialog"]');
    await act(async () => resolve(original));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(trigger));
  });
});
