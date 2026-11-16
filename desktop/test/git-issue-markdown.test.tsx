import { expect, test } from 'bun:test';
import { GitIssueMarkdown } from '../frontend/src/features/git/GitIssueMarkdown';
import { withDOM } from './agent-chats-test-dom';

test('issue Markdown renders emphasis, lists, tasks, tables and shared code panels', async () => {
  await withDOM(async ui => {
    await ui.render(<GitIssueMarkdown repository="owner/repo" issueNumber={18} text={[
      '**Important** and `inline`', '', '- first', '- second', '', '- [x] done', '',
      '| Name | Value |', '| --- | --- |', '| item | value |', '', '```ts', 'const ready = true;', '```',
    ].join('\n')} />);
    expect(document.querySelector('strong')?.textContent).toBe('Important');
    expect(document.querySelectorAll('li')).toHaveLength(3);
    const task = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(task.checked).toBe(true);
    expect(task.disabled).toBe(true);
    expect(document.querySelector('[aria-label="Issue table"] td')?.textContent).toBe('item');
    expect(document.querySelector('pre code')?.textContent).toBe('const ready = true;');
    expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Copy')).toBe(true);
  });
});

test('issue links open externally and resolve relative links against the GitHub issue', async () => {
  await withDOM(async ui => {
    await ui.render(<GitIssueMarkdown repository="owner/repo" issueNumber={18}
      text="[Docs](https://example.com/docs) [Comment](#issuecomment-7) [Related](19)" />);
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map(link => link.href)).toEqual([
      'https://example.com/docs', 'https://github.com/owner/repo/issues/18#issuecomment-7',
      'https://github.com/owner/repo/issues/19',
    ]);
    expect(links.every(link => link.target === '_blank' && link.rel === 'noreferrer')).toBe(true);
  });
});

test('untrusted issue Markdown cannot render HTML, fetch images or navigate to local and script URLs', async () => {
  await withDOM(async ui => {
    await ui.render(<GitIssueMarkdown repository="owner/repo" issueNumber={18} text={[
      '<script>alert(1)</script>', '', '<iframe src="https://example.com"></iframe>', '',
      '![preview](https://example.com/tracker.png)', '',
      '[Script](javascript:alert%281%29) [Local](file:///tmp/private) [Data](data:text/html,test)',
    ].join('\n')} />);
    expect(document.querySelector('script, iframe, img, a')).toBeNull();
    expect(document.body.textContent).toContain('preview');
    expect(document.body.textContent).toContain('Local');
  });
});
