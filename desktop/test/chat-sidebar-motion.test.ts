import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createChatSidebarMotion } from '../frontend/src/features/chat/chatSidebarMotion';

async function withMotion(run: (fixture: {
  root: HTMLElement;
  stage: HTMLElement;
  timeline: HTMLElement;
  content: HTMLElement;
  sheet: HTMLStyleElement;
  begin(): void;
  finish(target?: HTMLElement, property?: string): void;
  cancel(): void;
  dispose(): void;
}) => void | Promise<void>) {
  const window = new Window();
  const document = window.document as unknown as Document;
  const sheet = document.createElement('style');
  sheet.textContent = '[data-chat-layout-content] { width: 640px; }';
  document.head.append(sheet);
  const root = document.createElement('main');
  const stage = document.createElement('aside');
  stage.style.transitionProperty = 'width';
  stage.style.transitionDuration = '0.2s';
  stage.style.transitionDelay = '0s';
  const timeline = document.createElement('section');
  const content = document.createElement('div');
  content.setAttribute('data-chat-layout-content', '');
  timeline.append(content);
  root.append(timeline, stage);
  document.body.append(root);
  const motion = createChatSidebarMotion();
  const event = (type: string, property = 'width') => {
    const value = new window.Event(type, { bubbles: true });
    Object.defineProperty(value, 'propertyName', { value: property });
    return value as unknown as Event;
  };
  try {
    await run({ root, stage, timeline, content, sheet,
      begin: () => motion.begin(root, stage),
      finish: (target = stage, property = 'width') => target.dispatchEvent(event('transitionend', property)),
      cancel: () => stage.dispatchEvent(event('transitioncancel')),
      dispose: motion.dispose,
    });
  } finally {
    motion.dispose();
    await window.happyDOM.close();
  }
}

test('sidebar motion holds message width while headers remain free to resize, then releases it once', async () => {
  await withMotion(h => {
    h.begin();
    expect(h.content.style.width).toBe('640px');
    expect(h.stage.style.width).toBe('');
    h.root.style.width = '480px';
    h.sheet.textContent = '[data-chat-layout-content] { width: 480px; }';
    expect(h.content.style.width).toBe('640px');
    h.finish(h.content);
    h.finish(h.stage, 'opacity');
    expect(h.content.style.width).toBe('640px');
    h.finish();
    expect(h.content.style.width).toBe('');
    expect(h.content.ownerDocument.defaultView!.getComputedStyle(h.content).width).toBe('480px');
  });
});

test('rapid reversals keep the original line breaks and ignore cancelled transitions', async () => {
  await withMotion(h => {
    h.begin();
    h.sheet.textContent = '[data-chat-layout-content] { width: 500px; }';
    h.begin();
    h.cancel();
    expect(h.content.style.width).toBe('640px');
    h.begin();
    expect(h.content.style.width).toBe('640px');
    h.finish();
    expect(h.content.style.width).toBe('');
  });
});

test('cleanup restores authored inline widths and reduced motion does not hold content', async () => {
  await withMotion(h => {
    h.content.style.setProperty('width', '610px', 'important');
    h.begin();
    h.dispose();
    expect(h.content.style.getPropertyValue('width')).toBe('610px');
    expect(h.content.style.getPropertyPriority('width')).toBe('important');
    h.content.style.removeProperty('width');
    h.stage.style.transitionDuration = '0s';
    h.begin();
    expect(h.content.style.width).toBe('');
  });
});

test('a cancelled or hidden panel releases content through the timeout fallback', async () => {
  await withMotion(async h => {
    h.stage.style.transitionDuration = '1ms';
    h.begin();
    h.cancel();
    h.stage.hidden = true;
    expect(h.content.style.width).toBe('640px');
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(h.content.style.width).toBe('');
  });
});

test.each([true, false])('preserves latest-message following without pulling older-history readers down: %s', async following => {
  await withMotion(h => {
    Object.defineProperties(h.timeline, {
      clientHeight: { value: 100 },
      scrollHeight: { get: () => h.content.style.width ? 1000 : 1500 },
    });
    h.begin();
    h.timeline.scrollTop = following ? 900 : 300;
    h.finish();
    expect(h.timeline.scrollTop).toBe(following ? 1500 : 300);
  });
});
