import { expect, test } from 'bun:test';

import { paneDisplayPath } from '../frontend/src/features/terminal/paneTitle';

test('shows only the path from a shell pane title', () => {
  expect(paneDisplayPath('developer@workstation:~/projects')).toBe('~/projects');
  expect(paneDisplayPath('developer@host:/Users/developer/projects/example')).toBe(
    '/Users/developer/projects/example',
  );
});

test('preserves titles that are not shell path titles', () => {
  expect(paneDisplayPath('vim: README.md')).toBe('vim: README.md');
  expect(paneDisplayPath('Terminal 1')).toBe('Terminal 1');
});
