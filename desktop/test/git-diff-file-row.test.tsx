import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GitDiffFileRow } from '../frontend/src/features/git/GitDiffFileRow';

test('opening a diff file routes its exact workspace path without changing the diff selection', () => {
  const path = 'src/한글 folder/example.tsx';
  const selected: string[] = [];
  const opened: string[] = [];
  const row = GitDiffFileRow({ path, selected: false,
    onSelectPath: (value) => selected.push(value), onOpenWorkspaceFile: (value) => opened.push(value) });
  const [selection, open] = row.props.children;
  open.props.onClick();
  expect(opened).toEqual([path]);
  expect(selected).toEqual([]);
  selection.props.onClick();
  expect(selected).toEqual([path]);
  expect(opened).toEqual([path]);
});

test('diff selection and file navigation remain separate accessible buttons', () => {
  const html = renderToStaticMarkup(<GitDiffFileRow path="src/example.tsx" selected
    onSelectPath={() => {}} onOpenWorkspaceFile={() => {}} />);
  expect(html.match(/<button\b/g)).toHaveLength(2);
  expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('aria-label="Open file in editor: src/example.tsx"');
  expect(html.match(/type="button"/g)).toHaveLength(2);
});
