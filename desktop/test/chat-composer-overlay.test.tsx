import { expect, test } from 'bun:test';
import { syncChatComposerOverlayHeight } from '../frontend/src/features/chat/chatComposerOverlay';

function overlayHarness() {
  const contentHeight = 1600;
  const viewportHeight = 600;
  let overlayHeight = 118;
  let scrollTop = contentHeight + overlayHeight - viewportHeight;
  const scrolls: ScrollToOptions[] = [];
  const root = {
    style: {
      setProperty(name: string, value: string) {
        expect(name).toBe('--composer-overlay-height');
        overlayHeight = Number.parseFloat(value);
      },
    },
  };
  const timeline = {
    get scrollHeight() { return contentHeight + overlayHeight; },
    scrollTo(optionsOrX?: ScrollToOptions | number, _y?: number) {
      if (typeof optionsOrX !== 'object') throw new Error('Expected scroll options');
      scrolls.push(optionsOrX);
      scrollTop = Math.min(optionsOrX.top ?? scrollTop, this.scrollHeight - viewportHeight);
    },
  };
  return {
    root, timeline, scrolls,
    sync: (height: number, follow = true) => syncChatComposerOverlayHeight(root, height, timeline, follow),
    position: () => scrollTop,
    bottomGap: () => timeline.scrollHeight - scrollTop - viewportHeight,
    readHistory: () => { scrollTop = 400; },
  };
}

test('opening a question card preserves the bottom after updating overlay padding without new messages', () => {
  const h = overlayHarness();
  expect(h.bottomGap()).toBe(0);
  expect(h.sync(340.4)).toBe(true);
  expect(h.bottomGap()).toBe(0);
  expect(h.scrolls).toEqual([{ top: 1941, behavior: 'instant' }]);
});

test('closing and resizing the question card keep a followed conversation at the bottom', () => {
  const h = overlayHarness();
  for (const height of [340, 400, 118]) {
    expect(h.sync(height)).toBe(true);
    expect(h.bottomGap()).toBe(0);
  }
});

test('overlay changes preserve the reading position when the user is viewing earlier messages', () => {
  const h = overlayHarness();
  h.readHistory();
  for (const height of [340, 400, 118]) {
    expect(h.sync(height, false)).toBe(false);
    expect(h.position()).toBe(400);
  }
  expect(h.scrolls).toEqual([]);
  expect(h.sync(340, true)).toBe(true);
  expect(h.bottomGap()).toBe(0);
});

test('an absent timeline still receives the new overlay height without trying to scroll', () => {
  const h = overlayHarness();
  expect(syncChatComposerOverlayHeight(h.root, 340, null, true)).toBe(false);
  expect(h.timeline.scrollHeight).toBe(1940);
  expect(h.scrolls).toEqual([]);
});
