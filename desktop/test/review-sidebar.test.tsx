import { expect, mock, test } from 'bun:test';
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
