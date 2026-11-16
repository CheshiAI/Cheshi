import { expect, test } from 'bun:test';
import { act } from 'react';
import { InlineRenameField } from '../frontend/src/shared/ui/InlineRenameField';
import { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred as createDeferred } from './agent-registry-fixtures';

async function key(key: string, options: KeyboardEventInit = {}) {
  await act(async () => document.querySelector('input[aria-label="Session title"]')!.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })));
}

test('session rename edits its row without selecting or deleting, then saves the identified session', async () => {
  await withDOM(async ui => {
    const renamed: string[][] = [], opened: string[] = [], deleted: string[] = [], editing: boolean[] = [];
    await ui.render(<ChatSessionList sessions={[{ id: 'saved', title: 'Long title', preview: '', createdAt: 1, updatedAt: 1, status: 'idle' }]}
      loading={false} activeSessionId={null} responseThreadIds={[]} newChatDisabled={false} selectionDisabled={false}
      onOpen={id => opened.push(id)} onDelete={id => deleted.push(id)} onRename={async (id, title) => { renamed.push([id, title]); }}
      onRenamingChange={value => editing.push(value)} onNew={() => {}} deleteReason={() => null} />);
    await ui.click('Rename chat: Long title');
    expect(document.querySelector('dialog')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Session title"]')!;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Long title'.length]);
    expect(editing.at(-1)).toBe(true);
    await ui.type('Session title', '  Short  '); await key('Enter');
    expect(renamed).toEqual([['saved', 'Short']]);
    expect(opened).toEqual([]); expect(deleted).toEqual([]);
    expect(document.querySelector('[aria-label="Session title"]')).toBeNull();
    expect(editing.at(-1)).toBe(false);
  });
});

test('inline rename rejects blank input, cancels with Escape or blur, and skips unchanged titles', async () => {
  await withDOM(async ui => {
    const titles: string[] = []; let closed = 0;
    await ui.render(<><InlineRenameField initialTitle="Original" inputLabel="Session title"
      onSave={async title => { titles.push(title); }} onClose={() => { closed++; }} /><button aria-label="Outside">Outside</button></>);
    await ui.type('Session title', '   '); await key('Enter');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Title must not be empty.');
    expect(titles).toEqual([]); expect(closed).toBe(0);
    await key('Escape'); expect(closed).toBe(1);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Outside"]')!.focus());
    expect(closed).toBe(2);
    await ui.type('Session title', 'Original'); await key('Enter');
    expect(titles).toEqual([]); expect(closed).toBe(3);
  });
});

test('inline rename blocks duplicate saves and dismissal while pending', async () => {
  await withDOM(async ui => {
    const pending = createDeferred<void>(); const titles: string[] = []; let closed = 0;
    await ui.render(<><InlineRenameField initialTitle="Original" inputLabel="Session title"
      onSave={title => { titles.push(title); return pending.promise; }} onClose={() => { closed++; }} /><button aria-label="Outside">Outside</button></>);
    await ui.type('Session title', '  Short title  '); await key('Enter'); await key('Enter');
    expect(titles).toEqual(['Short title']);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Session title"]')?.readOnly).toBe(true);
    await key('Escape');
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Outside"]')!.focus());
    expect(closed).toBe(0);
    await act(async () => pending.resolve()); expect(closed).toBe(1);
  });
});

test('inline rename preserves a failed title for retry', async () => {
  await withDOM(async ui => {
    let attempts = 0, closed = 0;
    await ui.render(<InlineRenameField initialTitle="Original" inputLabel="Session title"
      onSave={async () => { attempts++; if (attempts === 1) throw new Error('Save failed'); }} onClose={() => { closed++; }} />);
    await ui.type('Session title', 'Retry title'); await key('Enter');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Save failed');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Session title"]')?.value).toBe('Retry title');
    expect(closed).toBe(0); await key('Enter');
    expect(closed).toBe(1); expect(attempts).toBe(2);
  });
});

test('Korean composition Enter and Escape do not submit or cancel', async () => {
  await withDOM(async ui => {
    const titles: string[] = []; let closed = 0;
    await ui.render(<InlineRenameField initialTitle="Original" inputLabel="Session title"
      onSave={async title => { titles.push(title); }} onClose={() => { closed++; }} />);
    await ui.type('Session title', '한글 제목');
    await key('Enter', { isComposing: true }); await key('Escape', { isComposing: true });
    await key('Enter', { keyCode: 229 });
    expect(titles).toEqual([]); expect(closed).toBe(0);
    await key('Enter'); expect(titles).toEqual(['한글 제목']); expect(closed).toBe(1);
  });
});
