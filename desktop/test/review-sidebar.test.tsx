import { expect, mock, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, useState } from 'react';
import { withDOM } from './agent-chats-test-dom';
import type { ChatActivityItem } from '../frontend/src/features/chat/model';
import type { GitLineBlameRequest } from '../shared/git-line-blame';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ReviewSidebar } = await import('../frontend/src/features/shell/ReviewSidebar');

const item: ChatActivityItem = {
  id: 'change', kind: 'activity', activity: 'files', label: 'Files', detail: '', status: 'completed',
  changes: [{ path: 'sample.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new', movePath: null }],
};

test('file review restores focus before hiding its sidebar controls', async () => {
  function Workspace() {
    const [review, setReview] = useState<ChatActivityItem | null>(null);
    return <div>
      <button onClick={() => setReview(item)}>Review changes</button>
      <ReviewSidebar open item={review} initialPath={null} onCloseReview={() => setReview(null)} />
    </div>;
  }
  await withDOM(async ui => {
    await ui.render(<Workspace />);
    const opener = document.querySelector<HTMLButtonElement>('button')!;
    await act(async () => opener.focus());
    await ui.click('Review changes');
    const sidebar = document.querySelector('[aria-label="Review sidebar"]')!;
    expect(sidebar.getAttribute('data-open')).toBe('true');
    expect(sidebar.getAttribute('aria-hidden')).toBe('false');
    const close = sidebar.querySelector<HTMLButtonElement>('[aria-label="Close file changes review"]')!;
    await act(async () => close.focus());
    await ui.click('Close file changes review');
    expect(sidebar.getAttribute('data-open')).toBe('false');
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(sidebar.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
});

test('overlay review focuses its close control, respects nested dialogs and restores the opener on Escape', async () => {
  function Workspace() {
    const [review, setReview] = useState<ChatActivityItem | null>(null);
    return <div className="app-layout">
      <div className="workspace-column"><div style={{ minWidth: 596 }}>
        <button onClick={() => setReview(item)}>Review changes</button>
      </div></div>
      <ReviewSidebar open item={review} initialPath={null} onCloseReview={() => setReview(null)} />
    </div>;
  }
  await withDOM(async ui => {
    const geometry = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const left = this.className === 'workspace-column' ? 398 : 0;
      return { x: left, y: 0, left, right: 1280, top: 0, bottom: 700, width: 1280 - left, height: 700, toJSON: () => ({}) };
    });
    try {
      await ui.render(<Workspace />);
      const opener = document.querySelector<HTMLButtonElement>('button')!;
      opener.focus();
      await ui.click('Review changes');
      const slot = document.querySelector<HTMLElement>('[aria-label="Review sidebar"]')!;
      expect(slot.dataset.overlay).toBe('true');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close file changes review');
      const escape = async (prevented = false) => {
        const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        if (prevented) event.preventDefault();
        await act(async () => document.activeElement!.dispatchEvent(event));
      };
      await escape(true);
      expect(slot.dataset.open).toBe('true');
      const dialog = document.createElement('dialog');
      dialog.setAttribute('open', '');
      document.body.append(dialog);
      await escape();
      expect(slot.dataset.open).toBe('true');
      dialog.remove();
      await escape();
      expect(slot.dataset.open).toBe('false');
      expect(slot.hasAttribute('inert')).toBe(true);
      expect(document.activeElement).toBe(opener);
      await ui.click('Review changes');
      await ui.click('Close file changes review');
      expect(slot.dataset.open).toBe('false');
      expect(document.activeElement).toBe(opener);
    } finally { geometry.mockRestore(); }
  });
});

function render(open: boolean, review: ChatActivityItem | null, lineCommit: GitLineBlameRequest | null = null) {
  const html = renderToStaticMarkup(<ReviewSidebar open={open} item={review} lineCommit={lineCommit} initialPath="sample.ts" onCloseReview={() => {}} />);
  return [...html.matchAll(/<aside\b([^>]*)>([\s\S]*?)<\/aside>/g)].map((match) => ({ attributes: match[1]!, body: match[2]! }));
}

test('does not allocate an empty right chat column when no review is open', () => {
  const panels = render(true, null);
  expect(panels).toHaveLength(1);
  const [review] = panels;
  expect(review?.attributes).toContain('data-open="false"');
  expect(review?.attributes).toContain('aria-hidden="true"');
  expect(review?.attributes).toContain('inert=""');
});

test('line commits open in the right review sidebar and become inaccessible when closed', () => {
  const request = { path: 'sample.ts', line: 1, content: 'draft' };
  const [review] = render(true, null, request);
  expect(review?.attributes).toContain('data-open="true"');
  expect(review?.attributes).not.toContain('inert=');
  expect(review?.body).toContain('aria-label="Line commit"');
  expect(review?.body).not.toContain('<dialog');
  for (const panel of render(false, null, request)) {
    expect(panel.attributes).toContain('inert=""');
    expect(panel.attributes).toContain('aria-hidden="true"');
  }
});

test('file changes remain available in the right review panel', () => {
  const [review] = render(true, item);
  expect(review?.attributes).toContain('data-open="true"');
  expect(review?.attributes).toContain('aria-hidden="false"');
  expect(review?.attributes).not.toContain('inert=');
  expect(review?.body).toContain('Diff for sample.ts');
});

test('closing the review keeps its content mounted but inaccessible', () => {
  for (const panel of render(false, item)) {
    expect(panel.attributes).toContain('data-open="false"');
    expect(panel.attributes).toContain('aria-hidden="true"');
    expect(panel.attributes).toContain('inert=""');
    expect(panel.body).toContain('Diff for sample.ts');
  }
});

for (const panel of ['files', 'line commit'] as const) {
  test(`${panel} review uses the remaining space and preserves the workspace minimum on resize`, async () => {
    await withDOM(async ui => {
      let layoutWidth = 1280;
      let workspaceLeft = 398; // 78px rail + 320px sidebar.
      const observers = new Set<() => void>();
      const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')!;
      class Observer {
        constructor(privateCallback: () => void) { this.callback = privateCallback; observers.add(privateCallback); }
        callback: () => void;
        observe() {}
        disconnect() { observers.delete(this.callback); }
      }
      Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
      const geometry = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const left = this.className === 'workspace-column' ? workspaceLeft : 0;
        const width = layoutWidth - left;
        return { x: left, y: 0, left, right: layoutWidth, top: 0, bottom: 700, width, height: 700, toJSON: () => ({}) };
      });
      const render = (open = true, minimum = 475) => <div className="app-layout">
        <div className="workspace-column"><div style={{ minWidth: minimum }} /></div>
        <ReviewSidebar open={open} item={panel === 'files' ? item : null} initialPath={null}
          lineCommit={panel === 'line commit' ? { path: 'sample.ts', line: 1, content: '' } : null}
          onCloseReview={() => {}} />
      </div>;
      const resized = async () => { await act(async () => { for (const notify of observers) notify(); }); };
      try {
        await ui.render(render());
        const slot = document.querySelector<HTMLElement>('[aria-label="Review sidebar"]')!;
        const width = () => Number.parseFloat(slot.style.getPropertyValue('--review-width'));
        expect(width()).toBeCloseTo(407);
        expect(layoutWidth - workspaceLeft - width()).toBeCloseTo(475);
        expect(slot.querySelector('[role="separator"]') !== null).toBe(panel === 'line commit');
        if (panel === 'line commit') {
          await act(async () => slot.querySelector('[role="separator"]')!.dispatchEvent(
            new window.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
          expect(width()).toBeCloseTo(407);
          await act(async () => slot.querySelector('[role="separator"]')!.dispatchEvent(
            new window.MouseEvent('dblclick', { bubbles: true })));
        }
        workspaceLeft = 78;
        await resized();
        expect(width()).toBeCloseTo(601);
        workspaceLeft = 398;
        layoutWidth = 1600;
        await resized();
        expect(width()).toBeCloseTo(601);
        layoutWidth = 1280;
        await resized();
        expect(width()).toBeCloseTo(407);
        await ui.render(render(true, 596)); // Chat and another workspace pane.
        await resized();
        expect(slot.dataset.overlay).toBe('true');
        expect(width()).toBeCloseTo(441);
        expect(slot.querySelector('[role="separator"]')).toBeNull();
        await ui.render(render(true, 475));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(slot.dataset.overlay).toBeUndefined();
        expect(width()).toBeCloseTo(407);
        await ui.render(render(true, 596));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(slot.dataset.overlay).toBe('true');
        layoutWidth = 1600;
        await resized();
        expect(slot.dataset.overlay).toBeUndefined();
        expect(width()).toBeCloseTo(601);
        layoutWidth = 1280;
        await resized();
        expect(slot.dataset.overlay).toBe('true');
        expect(width()).toBeCloseTo(441);
        layoutWidth = 650;
        await resized();
        expect(width()).toBeCloseTo(252);
        expect(slot.querySelector('[aria-label="Close file changes review"], [aria-label="Close line commit"]')).not.toBeNull();
        await ui.render(render(false));
        expect(slot.dataset.open).toBe('false');
        layoutWidth = 1280;
        workspaceLeft = 78;
        await ui.render(render());
        expect(width()).toBeCloseTo(601);
      } finally {
        geometry.mockRestore();
        Object.defineProperty(globalThis, 'ResizeObserver', previousObserver);
      }
    });
  });
}
