import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatActivityItem } from '../frontend/src/features/chat/model';
import type { GitLineBlameRequest } from '../shared/git-line-blame';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ReviewSidebar } = await import('../frontend/src/features/shell/ReviewSidebar');

const item: ChatActivityItem = {
  id: 'change', kind: 'activity', activity: 'files', label: 'Files', detail: '', status: 'completed',
  changes: [{ path: 'sample.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new', movePath: null }],
};

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
