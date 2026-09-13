import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatActivityItem } from '../frontend/src/features/chat/model';

mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: undefined }));
const { ReviewSidebar } = await import('../frontend/src/features/shell/ReviewSidebar');

const item: ChatActivityItem = {
  id: 'change', kind: 'activity', activity: 'files', label: 'Files', detail: '', status: 'completed',
  changes: [{ path: 'sample.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new', movePath: null }],
};

function render(open: boolean, review: ChatActivityItem | null) {
  const html = renderToStaticMarkup(<ReviewSidebar open={open} item={review} initialPath="sample.ts" onCloseReview={() => {}}>
    <button type="button">Choose conversation</button>
  </ReviewSidebar>);
  return [...html.matchAll(/<aside\b([^>]*)>([\s\S]*?)<\/aside>/g)].map((match) => ({ attributes: match[1]!, body: match[2]! }));
}

test('keeps the original sidebar available when no review is open', () => {
  const [sidebar, review] = render(true, null);
  expect(sidebar?.attributes).toContain('right-sidebar-column');
  expect(sidebar?.attributes).toContain('data-open="true"');
  expect(sidebar?.attributes).toContain('aria-hidden="false"');
  expect(sidebar?.body).toContain('Choose conversation');
  expect(review?.attributes).toContain('inert=""');
});

test('retains sidebar content while only the review is available for interaction', () => {
  const [sidebar, review] = render(true, item);
  expect(sidebar?.body).toContain('Choose conversation');
  expect(sidebar?.attributes).toContain('data-open="false"');
  expect(sidebar?.attributes).toContain('inert=""');
  expect(review?.attributes).toContain('data-open="true"');
  expect(review?.attributes).toContain('aria-hidden="false"');
  expect(review?.attributes).not.toContain('inert=');
  expect(review?.body).toContain('Diff for sample.ts');
});

test('closing the sidebar makes both mounted panels inaccessible', () => {
  for (const panel of render(false, item)) {
    expect(panel.attributes).toContain('data-open="false"');
    expect(panel.attributes).toContain('aria-hidden="true"');
    expect(panel.attributes).toContain('inert=""');
  }
});
