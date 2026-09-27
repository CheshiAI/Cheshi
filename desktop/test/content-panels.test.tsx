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
    expect(container.querySelector('button')?.textContent).toBe('Copied');
    await act(async () => root.render(render('next output')));
    expect(container.querySelector('button')?.textContent).toBe('Copy');
    rejectCopy = true;
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Could not copy');
    rejectCopy = false;
    await act(async () => container.querySelector('button')?.click());
    expect(written).toEqual([code, 'next output']);
    expect(container.querySelector('[role="status"]')).toBeNull();
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

test('web search cards retain the result description and distinguish running and interrupted states', () => {
  const item: ChatActivityItem = { id: 'search', kind: 'activity', activity: 'search',
    label: 'Web search', detail: 'https://example.com/source', status: 'inProgress' };
  const render = (status: ChatActivityItem['status']) => renderToStaticMarkup(
    <ChatTimelineItem item={{ ...item, status }} streaming={false} onReviewFileChanges={() => {}} />,
  );
  expect(render('inProgress')).toContain('role="status">In progress');
  expect(render('completed')).toContain(item.detail);
  expect(render('completed')).not.toContain('In progress');
  expect(render('interrupted')).toContain('Response stopped');
  expect(render('failed')).toContain('Failed');
});
