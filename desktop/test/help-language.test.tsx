import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHelpLanguageStore, normalizeHelpLanguage } from '../frontend/src/shared/useHelpLanguage';
import { LanguageSelector } from '../frontend/src/features/shell/LanguageSelector';
import { getHelpArticles } from '../frontend/src/features/help/helpArticles';
import { searchHelp } from '../frontend/src/features/help/helpCatalog';
import { HelpPanel } from '../frontend/src/features/help/HelpPanel';

test('English is the default for missing or unsupported saved languages', () => {
  for (const value of [null, undefined, '', 'fr', 'KO', true, {}]) expect(normalizeHelpLanguage(value)).toBe('en');
  expect(normalizeHelpLanguage('ko')).toBe('ko');
  expect(createHelpLanguageStore({ read: () => null, write: () => {} }).getSnapshot()).toBe('en');
});

test('language changes notify subscribers and restore the saved selection in a new session', () => {
  let saved: string | null = null;
  const storage = { read: (): string | null => saved, write: (value: string) => { saved = value; } };
  const store = createHelpLanguageStore(storage);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  store.setLanguage('ko');
  expect(store.getSnapshot()).toBe('ko');
  expect(storage.read()).toBe('ko');
  expect(notifications).toBe(1);
  expect(createHelpLanguageStore(storage).getSnapshot()).toBe('ko');
  store.setLanguage('ko');
  expect(notifications).toBe(1);
  saved = 'en';
  store.refresh();
  expect(store.getSnapshot()).toBe('en');
  expect(notifications).toBe(2);
  unsubscribe();
  store.setLanguage('ko');
  expect(notifications).toBe(2);
});

test('storage failure does not prevent changing the language during the current session', () => {
  const store = createHelpLanguageStore({
    read: () => { throw new Error('Storage unavailable'); },
    write: () => { throw new Error('Storage unavailable'); },
  });
  expect(store.getSnapshot()).toBe('en');
  store.setLanguage('ko');
  store.refresh();
  expect(store.getSnapshot()).toBe('ko');
});

test('language menu offers English and Korean with English initially selected', () => {
  const html = renderToStaticMarkup(<LanguageSelector />);
  expect(html).toContain('Languages');
  expect(html).toContain('popover="auto"');
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('role="menuitemradio" lang="en" aria-checked="true"');
  expect(html).toContain('role="menuitemradio" lang="ko" aria-checked="false"');
  expect(html).toContain('English');
  expect(html).toContain('한국어');
});

test('both languages provide matching topics and related links with localized searchable documents', () => {
  const english = getHelpArticles('en');
  const korean = getHelpArticles('ko');
  expect(korean.map(article => article.id)).toEqual(english.map(article => article.id));
  for (const article of korean) {
    const counterpart = english.find(item => item.id === article.id)!;
    expect(article.related).toEqual(counterpart.related);
    expect(article.markdown).toContain('## 어떻게 하나요');
    expect(counterpart.markdown).toContain('## Steps');
  }
  expect(searchHelp(korean, '복원 미저장').some(article => article.id === 'local-history')).toBe(true);
  expect(searchHelp(english, 'restore unsaved').some(article => article.id === 'local-history')).toBe(true);
  const html = renderToStaticMarkup(<HelpPanel id="korean-help" open language="ko" articles={korean} onClose={() => {}} />);
  expect(html).toContain('lang="ko"');
  expect(html).toContain('도움말 닫기');
  expect(html).toContain('무엇을 하고 싶으세요?');
  for (const article of korean) expect(html).toContain(article.title);
});
