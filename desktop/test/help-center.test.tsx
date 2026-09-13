import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { helpArticles } from '../frontend/src/features/help/helpArticles';
import { searchHelp } from '../frontend/src/features/help/helpCatalog';
import { HelpPanel } from '../frontend/src/features/help/HelpPanel';

test('bundled help contains six complete offline documents with valid related topics', () => {
  expect(helpArticles).toHaveLength(6);
  const ids = new Set(helpArticles.map(article => article.id));
  expect(ids.size).toBe(helpArticles.length);
  for (const article of helpArticles) {
    expect(article.markdown.startsWith('# ')).toBe(true);
    for (const heading of ['## When to use it', '## Steps', '## What happens next']) {
      expect(article.markdown).toContain(heading);
    }
    expect(article.markdown).not.toMatch(/https?:\/\/|!\[|<script/iu);
    for (const related of article.related) {
      expect(ids.has(related)).toBe(true);
      expect(related).not.toBe(article.id);
    }
  }
});

test('help searches English menu names and body text without regex interpretation', () => {
  expect(searchHelp(helpArticles, '  ')).toEqual(helpArticles);
  expect(searchHelp(helpArticles, 'ＣＲＥＡＴＥ project').some(article => article.id === 'projects')).toBe(true);
  expect(searchHelp(helpArticles, 'restore unsaved').some(article => article.id === 'local-history')).toBe(true);
  expect(searchHelp(helpArticles, 'current SAVED file').some(article => article.id === 'local-history')).toBe(true);
  expect(searchHelp(helpArticles, '[.*')).toEqual([]);
  expect(searchHelp(helpArticles, 'noMatchingHelp123')).toEqual([]);
});

test('closed help is inert and hidden from assistive navigation', () => {
  const html = renderToStaticMarkup(<HelpPanel id="help-test" open={false} articles={helpArticles} onClose={() => {}} />);
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('inert=""');
  expect(html).toContain('data-open="false"');
});

test('open help exposes searchable topics without making the workspace modal', () => {
  const html = renderToStaticMarkup(<HelpPanel id="help-test" open articles={helpArticles} onClose={() => {}} />);
  expect(html).toContain('role="complementary"');
  expect(html).not.toContain('aria-modal');
  expect(html).not.toContain('inert=""');
  expect(html).toContain('aria-label="Search help"');
  expect(html).toContain('aria-label="Close help"');
  expect(html).toContain('Popular guides');
  for (const article of helpArticles) expect(html).toContain(article.title);
});
