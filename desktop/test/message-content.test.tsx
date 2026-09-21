import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { Window } from 'happy-dom';
import type { ChatWorkspaceController } from '../frontend/src/features/chat/useChatWorkspace';
import type { ChatRelayState } from '../shared/chat-relay';
import { timelineFromThread } from '../lib/codex-chat-thread-data.mts';
import { normalizeOpenSessionResponse } from '../frontend/src/features/chat/model';

const desktop: { openLocalFileLink?: (href: string) => Promise<void> } = {};
mock.module('../frontend/src/cheshiDesktop', () => ({ cheshiDesktop: desktop }));
const { MessageContent } = await import('../frontend/src/features/chat/MessageContent');
const { ChatRelayStatus } = await import('../frontend/src/features/chat/ChatRelayControls');

const table = '| 방식 | 주요 이점 |\n|---|---|\n| **상시 표시** | 초안 비교 |\n| 활성 패널 | 읽기 공간 |';
const render = (text: string, renderLocalImages = false) => renderToStaticMarkup(<MessageContent text={text} renderLocalImages={renderLocalImages} />);

function resultWorkspace(state: ChatRelayState): ChatWorkspaceController {
  // Only the relay status boundary is exercised; other workspace operations are not mounted.
  return { relay: { state, displayedState: state, selectedResult: null, error: null, running: false, pending: false, dismissResult() {}, dismissError() {} } } as ChatWorkspaceController;
}

describe('chat Markdown rendering', () => {
  test('renders Korean comparison tables and inline formatting as semantic elements', () => {
    const html = render(table);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>방식</th>');
    expect(html).toContain('<strong>상시 표시</strong>');
    expect(html.match(/<tbody>/g)).toHaveLength(1);
    expect(html).not.toContain('|---|');
  });

  test('renders headings, nested lists, quotes, strikethrough and task lists', () => {
    const html = render('## 결론\n\n- **동의**\n  - *조건*\n\n> 인용\n\n~~취소~~\n\n- [x] 완료\n- [ ] 대기');
    expect(html).toContain('<h2>결론</h2>');
    expect(html.match(/<ul(?:\s[^>]*)?>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('<em>조건</em>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<del>취소</del>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled=""');
  });

  test('keeps fenced, indented and inline code literal and preserves JSON presentation', () => {
    const html = render('Use `a | b`.\n\n```ts\nconst value = "**literal**";\n```\n\n    | not a table |');
    expect(html.match(/<pre>/g)).toHaveLength(2);
    expect(html).toContain('**literal**');
    expect(html).not.toContain('<strong>literal</strong>');
    expect(html).toContain('Copy');
    expect(render('{"ok":true}')).toContain('<pre>');
    expect(render('```ts\nconst incomplete = 1')).toContain('<pre>');
  });

  test('supports escaped table separators and column alignment', () => {
    const html = render('| Left | Right |\n|:---|---:|\n| a \\| b | `code` |');
    expect(html).toContain('a | b');
    expect(html).toContain('text-align:right');
  });

  test('does not activate raw HTML, unsafe links or remote images', () => {
    const html = render('<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n![tracking](https://example.com/pixel.png)\n\n[repo](https://github.com/example/repo)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://github.com/example/repo"');
    expect(html).toContain('target="_blank"');
  });

  test('preserves report links, encoded spaces and source locations without enabling other protocols', () => {
    const html = render('[보고서](/private/tmp/report/REPORT.md)\n\n[공백](</tmp/한글 report.md>)\n\n[source](app.ts:12)\n\n[unsafe](file:///tmp/a.md)\n\n[network](//example.com/a)');
    expect(html).toContain('href="/private/tmp/report/REPORT.md"');
    expect(html).toContain('href="/tmp/%ED%95%9C%EA%B8%80%20report.md"');
    expect(html).toContain('href="app.ts:12"');
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain('href="//');
    expect(html).not.toContain('target="_blank"');
  });

  test('opens a local report only after a click, prevents navigation and displays open failures', async () => {
    const window = new Window();
    const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    let unmount = async () => {};
    try {
      const { createRoot } = await import('react-dom/client');
      const container = globalThis.document.createElement('div');
      globalThis.document.body.append(container);
      const root = createRoot(container);
      unmount = async () => { await act(async () => root.unmount()); };
      const opened: string[] = [];
      let fail = false;
      desktop.openLocalFileLink = async href => { opened.push(href); if (fail) throw new Error('Missing file.'); };
      await act(async () => root.render(<MessageContent text="[Report](/private/tmp/report/REPORT.md)" />));
      expect(opened).toEqual([]);
      const anchor = container.querySelector('a');
      if (!anchor) throw new Error('Expected a local report link.');
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => { anchor.dispatchEvent(click as unknown as MouseEvent); });
      expect(click.defaultPrevented).toBe(true);
      expect(opened).toEqual(['/private/tmp/report/REPORT.md']);
      fail = true;
      await act(async () => anchor.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not open this file');
      fail = false;
      await act(async () => anchor.click());
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await unmount();
      delete desktop.openLocalFileLink;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    }
  });

  test('preserves local attachment placeholders only when explicitly enabled', () => {
    const text = '[Image: /tmp/first.png]\n[Image: /tmp/second.png]';
    const html = render(text, true);
    expect(html.match(/role="img"/g)).toHaveLength(2);
    expect(html).toContain('Attached image: first.png');
    expect(render(text)).not.toContain('role="img"');
    expect(render('```text\n[Image: /tmp/first.png]\n```', true)).not.toContain('role="img"');
  });

  test('keeps consecutive image-only paragraphs in an inline thumbnail flow', () => {
    for (const separator of ['\n', '\n\n']) {
      const html = render(`[Image: /tmp/first.png]${separator}[Image: /tmp/second.png]\n\nCompare **both images**.`, true);
      expect(html.match(/role="img"/g)).toHaveLength(2);
      expect(html).not.toMatch(/<p>\s*<span/);
      expect(html).toContain('<p>Compare <strong>both images</strong>.</p>');
      expect(html.indexOf('Attached image: first.png')).toBeLessThan(html.indexOf('Attached image: second.png'));
    }
  });

  test('preserves surrounding text and code when grouping embedded thumbnails', () => {
    const html = render('Before\n[Image: /tmp/first.png]\n[Image: /tmp/second.png]\nAfter **images**.\n\n`[Image: /tmp/literal.png]`', true);
    expect(html.match(/role="img"/g)).toHaveLength(2);
    expect(html).toContain('Before');
    expect(html).toContain('After <strong>images</strong>.');
    expect(html).toContain('[Image: /tmp/literal.png]');
    expect(html).not.toContain('Attached image: literal.png');
  });

  test('restores image previews alongside file attachments when reopening a conversation', () => {
    const items = timelineFromThread({
      id: 'attachment-thread',
      turns: [{ id: 'turn', startedAt: 1, completedAt: 2, items: [{
        type: 'userMessage', id: 'user', content: [
          { type: 'text', text: 'Review these attachments\n\nAttached files:\n- "/tmp/notes.txt"' },
          { type: 'localImage', path: '/tmp/first.png' },
          { type: 'localImage', path: '/tmp/second.png' },
          { type: 'text', text: 'Keep both previews.' },
        ],
      }] }],
    });
    const restored = normalizeOpenSessionResponse({
      session: { id: 'attachment-thread', title: 'Attachments', preview: '', createdAt: 1, updatedAt: 2, status: 'idle' },
      items,
    }).items[0];
    if (!restored || restored.kind !== 'user') throw new Error('Expected the restored user message.');
    const html = render(restored.text, true);
    expect(html.match(/role="img"/g)).toHaveLength(2);
    expect(html).toContain('Attached image: first.png');
    expect(html).toContain('Attached image: second.png');
    expect(html).toContain('/tmp/notes.txt');
    expect(html).toContain('<p>Keep both previews.</p>');
    expect(html).not.toContain('[Image:');
  });

  test('uses the same Markdown rendering for completed relay summaries, proposals and issues', () => {
    const state: ChatRelayState = { id: 'relay', sourceContextId: 'a', sourceThreadId: 'thread-a', targetContextId: 'b',
      targetThreadId: 'thread-b', mode: 'debate', maxRounds: 2, round: 2, step: 4, speaker: 'B', phase: 'discussion',
      status: 'completed', outcome: 'debated', proposalVersion: null, proposal: '## Proposal\n\n**Keep drafts.**',
      issues: ['Check *focus*.'], summary: table, message: null };
    const html = renderToStaticMarkup(<ChatRelayStatus workspace={resultWorkspace(state)} />);
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>Keep drafts.</strong>');
    expect(html).toContain('<em>focus</em>');
    expect(html).not.toContain('|---|');
  });
});
