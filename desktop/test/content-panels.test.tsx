import { expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';

import { CodePanel } from '../frontend/src/shared/ui/CodePanel';
import { ContentCard } from '../frontend/src/shared/ui/ContentCard';
import { ChatTimelineItem } from '../frontend/src/features/chat/ChatTimelineItem';
import { CommandActivity } from '../frontend/src/features/chat/CommandActivity';
import type { ChatActivityItem } from '../frontend/src/features/chat/model';

async function withDom(run: (container: HTMLElement, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const element = window.document.createElement('div');
  window.document.body.append(element);
  const container = element as unknown as HTMLElement;
  const root = createRoot(container);
  try {
    await run(container, root);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test.each([false, true])('code panels preserve copying and retry behavior (nested: %s)', async (nested) => {
  await withDom(async (container, root) => {
    const written: string[] = [];
    let rejectCopy = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => {
        if (rejectCopy) throw new Error('Clipboard unavailable');
        written.push(value);
      },
    } });
    const render = (code: string) => {
      const panel = <CodePanel code={code} language="ts" />;
      return nested ? <ContentCard title="History source">{panel}</ContentCard> : panel;
    };
    const code = '<script>literal</script>\n  **not markdown**\n';
    await act(async () => root.render(render(code)));
    expect(container.querySelector('pre')?.textContent).toBe(code);
    expect(container.querySelector('script')).toBeNull();
    await act(async () => container.querySelector('button')?.click());
    expect(written).toEqual([code]);
    expect(container.querySelector('button')?.textContent).toBe(nested ? '복사됨' : 'Copied');
    await act(async () => root.render(render('next output')));
    expect(container.querySelector('button')?.textContent).toBe(nested ? '코드 · ts' : 'Copy');
    rejectCopy = true;
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Could not copy');
    rejectCopy = false;
    await act(async () => container.querySelector('button')?.click());
    expect(written).toEqual([code, 'next output']);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

test('each nested copy action identifies and copies only its own code block', async () => {
  await withDom(async (container, root) => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { written.push(value); },
    } });
    await act(async () => root.render(<ContentCard title="History source">
      <p>Surrounding message</p>
      <CodePanel code="first block" />
      <p>Explanation between blocks</p>
      <CodePanel code="second block" language="ts" />
    </ContentCard>));
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    for (const [index, button] of buttons.entries()) {
      expect(button.textContent).toBe(index === 0 ? '코드' : '코드 · ts');
      expect(button.getAttribute('aria-label')).toBe('코드 복사');
      const target = container.ownerDocument.getElementById(button.getAttribute('aria-controls')!);
      expect(target?.textContent).toBe(index === 0 ? 'first block' : 'second block');
      await act(async () => button.click());
    }
    expect(written).toEqual(['first block', 'second block']);
  });
});

test('command disclosure retains the user expansion while output and completion update', async () => {
  await withDom(async (container, root) => {
    const item: ChatActivityItem = { id: 'command', kind: 'activity', activity: 'command',
      label: 'Command', detail: 'echo result', status: 'inProgress' };
    await act(async () => root.render(<CommandActivity item={item} />));
    const disclosure = container.querySelector('details')!;
    expect(disclosure.open).toBe(false);
    await act(async () => { disclosure.open = true; });
    await act(async () => root.render(<CommandActivity item={{ ...item, output: 'partial' }} />));
    expect(container.querySelector('details')).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    expect(container.querySelector('[aria-label="Command output"]')?.textContent).toBe('partial');
    await act(async () => root.render(<CommandActivity item={{ ...item, status: 'completed', output: 'complete' }} />));
    expect(disclosure.open).toBe(true);
    expect(container.querySelector('summary')?.textContent).toContain('Completed');
    expect(container.querySelector('[aria-label="Command output"]')?.textContent).toBe('complete');
  });
});

test('file change cards retain counts and open the selected file after activity updates', async () => {
  await withDom(async (container, root) => {
    const reviewed: Array<[string, string | undefined]> = [];
    const item: ChatActivityItem = { id: 'files', kind: 'activity', activity: 'files', label: 'File changes',
      detail: '', status: 'inProgress', changes: [
        { path: 'src/first.ts', kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-old\n+new\n' },
        { path: 'src/second.ts', kind: 'add', movePath: null, diff: 'first\nsecond\n' },
      ] };
    const render = (status: ChatActivityItem['status']) => <ChatTimelineItem item={{ ...item, status }}
      streaming={false} onReviewFileChanges={(id, path) => reviewed.push([id, path])} />;
    await act(async () => root.render(render('inProgress')));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('In progress');
    expect(container.querySelector('header')?.textContent).toContain('Editing 2 files');
    expect(container.querySelector('header [aria-label="3 additions, 1 deletions"]')).not.toBeNull();
    await act(async () => root.render(render('completed')));
    expect(container.querySelector('header')?.textContent).toContain('Edited 2 files');
    expect(container.querySelector('[role="status"]')).toBeNull();
    const rows = [...container.querySelectorAll('button')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('[aria-label="1 additions, 1 deletions"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[aria-label="2 additions, 0 deletions"]')).not.toBeNull();
    await act(async () => { rows[1]?.click(); rows[0]?.click(); });
    expect(reviewed).toEqual([['files', 'src/second.ts'], ['files', 'src/first.ts']]);
  });
});

test.each([
  { activity: 'search', label: 'Web search', detail: 'https://example.com/source' },
  { activity: 'tool', label: 'codegraph_explore', detail: 'cheshi_codegraph' },
  { activity: 'context', label: 'Context compacted', detail: 'Conversation context was summarized' },
])('activity cards retain descriptions and distinguish states for $activity', ({ activity, label, detail }) => {
  const item: ChatActivityItem = { id: activity, kind: 'activity', activity, label, detail, status: 'inProgress' };
  const render = (status: ChatActivityItem['status']) => renderToStaticMarkup(
    <ChatTimelineItem item={{ ...item, status }} streaming={false} onReviewFileChanges={() => {}} />,
  );
  expect(render('inProgress')).toContain('role="status">In progress');
  expect(render('completed')).toContain(item.detail);
  expect(render('completed')).not.toContain('In progress');
  expect(render('completed')).toContain('Completed');
  expect(render('completed')).toContain(item.label);
  expect(render('interrupted')).toContain('Response stopped');
  expect(render('failed')).toContain('Failed');
  expect(render('declined')).toContain('Declined');
});
