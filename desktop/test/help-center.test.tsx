import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { helpArticles } from '../frontend/src/features/help/helpArticles';
import { searchHelp } from '../frontend/src/features/help/helpCatalog';
import { HelpPanel } from '../frontend/src/features/help/HelpPanel';
import { HelpCenter } from '../frontend/src/features/help/HelpCenter';
import { Window } from 'happy-dom';
import { act } from 'react';

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

test('native menu requests open one help panel, close restores editor focus, and unmount unsubscribes', async () => {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const host = document.createElement('div'), editor = document.createElement('textarea');
  document.body.append(editor, host); editor.value = 'Unsaved draft';
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  let request: (() => void) | null = null, unsubscribed = false;
  const api = { onHelpRequested(listener: () => void) {
    request = listener; return () => { request = null; unsubscribed = true; };
  } };
  const open = () => { if (!request) throw new Error('Missing menu subscription'); request(); };
  try {
    await act(async () => root.render(<HelpCenter api={api} />));
    expect(document.querySelector('[data-open="true"]')).toBeNull();
    editor.focus(); await act(async () => open());
    expect(document.querySelectorAll('[data-open="true"]')).toHaveLength(1);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search help');
    await act(async () => open());
    expect(document.querySelectorAll('[data-open="true"]')).toHaveLength(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close help"]')!.click());
    expect(document.querySelector('[data-open="true"]')).toBeNull();
    expect(document.activeElement).toBe(editor); expect(editor.value).toBe('Unsaved draft');
    await act(async () => open());
    await act(async () => window.document.activeElement!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[data-open="true"]')).toBeNull();
    expect(document.activeElement).toBe(editor);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
  expect(unsubscribed).toBe(true);
});
