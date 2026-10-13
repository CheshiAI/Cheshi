import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatRenameSessionDialog } from '../frontend/src/features/chat/ChatRenameSessionDialog';
import { ChatSessionList } from '../frontend/src/features/chat/ChatSessionList';
import { withDOM } from './agent-chats-test-dom';
import { registryDeferred as createDeferred } from './agent-registry-fixtures';

test('rename opens from its own row action without selecting or deleting the conversation', async () => {
  await withDOM(async ui => {
    const renamed: string[] = [], opened: string[] = [], deleted: string[] = [];
    await ui.render(<ChatSessionList sessions={[{ id: 'saved', title: 'Long title', preview: '', createdAt: 1, updatedAt: 1, status: 'idle' }]}
      loading={false} activeSessionId={null} responseThreadIds={[]} newChatDisabled={false} selectionDisabled={false}
      onOpen={id => opened.push(id)} onDelete={id => deleted.push(id)} onRename={session => renamed.push(session.title)} onNew={() => {}} deleteReason={() => null} />);
    await ui.click('Rename chat: Long title');
    expect(renamed).toEqual(['Long title']);
    expect(opened).toEqual([]); expect(deleted).toEqual([]);
  });
});

test('rename initializes the title, rejects blank input and cancels without saving', async () => {
  await withDOM(async ui => {
    const titles: string[] = []; let closed = 0;
    await ui.render(<ChatRenameSessionDialog sessionTitle="Original title" onSave={async title => { titles.push(title); }} onClose={() => { closed++; }} />);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Session title"]')?.value).toBe('Original title');
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Session title"]'));
    await ui.type('Session title', '   ');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(titles).toEqual([]);
    await ui.click('Cancel');
    expect(closed).toBe(1);
  });
});

test('rename trims on submit, prevents duplicates and dismissal while saving, and closes after acknowledgement', async () => {
  await withDOM(async ui => {
    const pending = createDeferred<void>(); const titles: string[] = []; let closed = 0;
    await ui.render(<ChatRenameSessionDialog sessionTitle="Original" onSave={title => { titles.push(title); return pending.promise; }} onClose={() => { closed++; }} />);
    await ui.type('Session title', '  Short title  ');
    const form = document.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(titles).toEqual(['Short title']);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Session title"]')?.disabled).toBe(true);
    await act(async () => document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true })));
    expect(closed).toBe(0);
    await act(async () => pending.resolve());
    expect(closed).toBe(1);
  });
});

test('failed rename preserves the edited title and supports retry; Escape cancels an idle dialog', async () => {
  await withDOM(async ui => {
    let attempts = 0, closed = 0;
    await ui.render(<ChatRenameSessionDialog sessionTitle="Original" onSave={async () => { attempts++; if (attempts === 1) throw new Error('Save failed'); }} onClose={() => { closed++; }} />);
    await ui.type('Session title', 'Retry title');
    await ui.click('Save');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Save failed');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Session title"]')?.value).toBe('Retry title');
    expect(closed).toBe(0);
    await ui.click('Save');
    expect(closed).toBe(1); expect(attempts).toBe(2);
    await act(async () => document.querySelector('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true })));
    expect(closed).toBe(2);
  });
});
