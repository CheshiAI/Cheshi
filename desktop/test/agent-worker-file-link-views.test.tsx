import { expect, test } from 'bun:test';
import { act } from 'react';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { LocalFileLinkContext, MessageContent } from '../frontend/src/features/chat/MessageContent';
import { withDOM } from './agent-chats-test-dom';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';

test('Worker Markdown clicks use their message identity and show failure without using the host opener', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const snapshot: ChatsSnapshot = { rooms: [{ id: 'room', workspace: '/source', name: 'Demo', engineId: 'docker:test', defaultAgentId: 'peer',
      members: [{ id: 'dev', accountId: 'account', name: 'Dev' }, { id: 'peer', accountId: 'account', name: 'Peer' }], createdAt: '2026-10-09T00:00:00Z' }],
      messages: [{ id: 'result', roomId: 'room', threadId: null, sender: 'dev', recipient: null, kind: 'message',
        text: '[Result](/workspace/result.txt:3)', createdAt: '2026-10-09T00:00:00Z' }] };
    let fail = false;
    await ui.render(<ChatsView active api={{ request: async request => {
      requests.push(request); if (fail && request.action === 'open-file') throw new Error('Missing retained file'); return snapshot;
    } }} />);
    const click = () => act(async () => document.querySelector<HTMLAnchorElement>('a[href="/workspace/result.txt:3"]')!.click());
    await click();
    expect(requests.at(-1)).toEqual({ action: 'open-file', roomId: 'room', messageId: 'result', href: '/workspace/result.txt:3' });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    fail = true; await click();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not open this file');
    expect(requests.filter(r => r.action === 'open-file')).toHaveLength(2);
  });
});

test('relative Markdown file links inherit the same Worker resolver', async () => {
  await withDOM(async ui => {
    const opened: string[] = [];
    await ui.render(<LocalFileLinkContext.Provider value={async href => { opened.push(href); }}>
      <MessageContent text={'[Result](./result.txt)'} />
    </LocalFileLinkContext.Provider>);
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="./result.txt"]')!.click());
    expect(opened).toEqual(['./result.txt']);
  });
});
