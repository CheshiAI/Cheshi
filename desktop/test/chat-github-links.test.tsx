import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { githubDraftLinks } from '../frontend/src/features/chat/chatGithubLinks';
import { GithubLinkChips } from '../frontend/src/features/chat/GithubLinkChips';

test('detects repository, issue and bare GitHub links without modifying the draft', () => {
  const draft = 'Check https://github.com/CheshiAI/Cheshi and github.com/CheshiAI/Cheshi/issues/12#discussion';
  expect(githubDraftLinks(draft)).toEqual([
    { href: 'https://github.com/CheshiAI/Cheshi', label: 'CheshiAI/Cheshi' },
    { href: 'https://github.com/CheshiAI/Cheshi/issues/12#discussion', label: 'CheshiAI/Cheshi/issues/12#discussion' },
  ]);
  expect(githubDraftLinks('No link here')).toEqual([]);
});

test('handles Markdown delimiters and deduplicates normalized hosts', () => {
  const draft = '[repo](https://github.com/org/repo). https://www.github.com/org/repo\ngithub.com/org/repo';
  expect(githubDraftLinks(draft)).toEqual([{ href: 'https://github.com/org/repo', label: 'org/repo' }]);
  expect(githubDraftLinks('https://github.com/org/repo/wiki/Topic_(detail)')[0]?.label).toBe('org/repo/wiki/Topic_(detail)');
});

test('rejects lookalike hosts, credentials and unrelated URLs', () => {
  expect(githubDraftLinks([
    'https://github.com.evil.test/org/repo', 'https://evil.test/github.com/org/repo',
    'https://github.com@evil.test/org/repo', 'https://user:secret@github.com/org/repo',
    'https://github.com:8443/org/repo', 'person@github.com', 'notgithub.com/org/repo', 'github.com.evil.test/repo',
  ].join(' '))).toEqual([]);
});

test('chips update from the current draft and expose accessible links using the local icon', () => {
  const html = renderToStaticMarkup(<GithubLinkChips draft="https://github.com/org/repo" />);
  expect(html).toContain('aria-label="GitHub links in message"');
  expect(html).toContain('aria-label="Open GitHub: org/repo"');
  expect(html).toContain('href="https://github.com/org/repo"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain('<img');
  expect(renderToStaticMarkup(<GithubLinkChips draft="" />)).toBe('');
});
