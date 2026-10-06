import { expect, test } from 'bun:test';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../frontend/src/features/chat/MessageContent';
import { fileEvidence } from '../frontend/src/features/chat/fileEvidenceModel';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatsSnapshot, RoomMessage } from '../shared/agent-chats';
import { specialistAgent } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

const hash = 'a'.repeat(64);
const block = `ChatsView.tsx\n${hash}\npackage.json\n${'b'.repeat(64)}`;
const text = `Review complete.\n\n\`\`\`text\n${block}\n\`\`\``;
const context = 'Files:\ndesktop/frontend/ChatsView.tsx (untracked 신규)\n`package.json`';

test('file evidence resolves only unique paths explicitly present in the request', () => {
  expect(fileEvidence(block, 'text', context)).toEqual([
    { file: 'ChatsView.tsx', sha256: hash, path: 'desktop/frontend/ChatsView.tsx' },
    { file: 'package.json', sha256: 'b'.repeat(64), path: 'package.json' },
  ]);
  expect(fileEvidence(`ChatsView.tsx\n${hash}`, undefined, 'a/ChatsView.tsx b/ChatsView.tsx'))
    .toEqual([{ file: 'ChatsView.tsx', sha256: hash }]);
  expect(fileEvidence(`ChatsView.tsx\n${hash}`, 'plaintext', ''))
    .toEqual([{ file: 'ChatsView.tsx', sha256: hash }]);
  expect(fileEvidence(`a/ChatsView.tsx\n${hash}`, 'text', 'b/ChatsView.tsx'))
    .toEqual([{ file: 'a/ChatsView.tsx', sha256: hash }]);
});

test('partial hashes, mixed code and unsafe paths remain ordinary code', () => {
  for (const value of ['', `ChatsView.tsx\n${hash.slice(1)}`, `${block}\nadditional text`,
    `${block}\nmissing.ts`, `../file.ts\n${hash}`, `file:///tmp/a.ts\n${hash}`, `//host/a.ts\n${hash}`,
    `a/../file.ts\n${hash}`, `javascript:alert.ts\n${hash}`]) {
    expect(fileEvidence(value, 'text', context)).toBeNull();
  }
  expect(fileEvidence(block, 'ts', context)).toBeNull();
  expect(fileEvidence(`ChatsView.tsx\n${hash}`, 'text', '/workspace/ChatsView.tsx ../ChatsView.tsx'))
    .toEqual([{ file: 'ChatsView.tsx', sha256: hash }]);
});

test('review rendering groups evidence with file links and collapsed full hashes', async () => {
  await withDOM(async ui => {
    await ui.render(<MessageContent text={text} reviewFileContext={context} />);
    expect(document.querySelector('pre')).toBeNull();
    expect(document.querySelector('[aria-label="Evidence files"]')?.children.length).toBe(2);
    expect([...document.querySelectorAll('a')].map(a => a.getAttribute('href')))
      .toEqual(['desktop/frontend/ChatsView.tsx', 'package.json']);
    const details = document.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(hash);
    expect(document.body.textContent).toContain('root');
    await act(async () => details.querySelector('summary')!.click());
    expect(details.open).toBe(true);
    expect(details.querySelectorAll('dd').length).toBe(2);
    expect(document.body.textContent).toContain('Review complete.');
  });
});

test('normal messages and description mode preserve literal code; unresolved files have no guessed links', () => {
  expect(renderToStaticMarkup(<MessageContent text={text} />)).toContain('<pre');
  expect(renderToStaticMarkup(<MessageContent text={text} presentation="description" reviewFileContext={context} />))
    .toContain('<pre');
  const unresolved = renderToStaticMarkup(<MessageContent text={text} reviewFileContext="" />);
  expect(unresolved).toContain('File evidence');
  expect(unresolved).not.toContain('<a ');
  expect(unresolved).not.toContain('Passed');
});

function snapshot(requestPatch: Partial<RoomMessage> = {}): ChatsSnapshot {
  const createdAt = '2026-10-06T00:00:00Z';
  const message = (id: string, sender: string, value: string): RoomMessage => ({
    id, roomId: 'room', threadId: null, sender, recipient: null, kind: 'message', text: value, createdAt, taskId: 'task',
  });
  return {
    rooms: [{ id: 'room', name: 'Review', workspace: '/project', engineId: 'docker:test', defaultAgentId: 'reviewer',
      members: [{ id: 'reviewer', name: 'Review Specialist', accountId: 'account' }], createdAt }],
    messages: [
      { ...message('request', 'user', context), recipient: 'reviewer', ...requestPatch },
      message('review', 'reviewer', text), message('user-code', 'user', text), message('dev-code', 'dev', text),
    ],
  };
}

const registry = {
  list: async () => ({ workspaceRoot: '/project', agents: [{ ...specialistAgent(), id: 'reviewer', role: 'verification' as const,
    accountId: 'account', assignments: [{ workspaceRoot: '/project', instructions: '' }] }] }),
  onDidChange: () => () => {},
};

test('Chats enables evidence only for review replies and Copy retains the complete original', async () => {
  await withDOM(async ui => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { writes.push(value); } } });
    await ui.render(<ChatsView active api={{ request: async () => snapshot() }} registry={registry} />);
    const article = document.querySelector('[data-message-id="review"]')!;
    expect(article.querySelectorAll('[aria-label="Evidence files"] a').length).toBe(2);
    expect(document.querySelector('[data-message-id="user-code"] pre')).not.toBeNull();
    expect(document.querySelector('[data-message-id="dev-code"] pre')).not.toBeNull();
    await act(async () => article.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    expect(writes).toEqual([text]);
  });
});

test.each<Partial<RoomMessage>>([{ taskId: 'other' }, { roomId: 'other' }, { recipient: 'other' }, { taskId: undefined }])(
  'Chats never uses unrelated request paths: %j', async patch => {
    await withDOM(async ui => {
      await ui.render(<ChatsView active api={{ request: async () => snapshot(patch) }} registry={registry} />);
      const article = document.querySelector('[data-message-id="review"]')!;
      expect(article.querySelector('[aria-label="Evidence files"]')).not.toBeNull();
      expect(article.querySelectorAll('[aria-label="Evidence files"] a').length).toBe(0);
    });
  },
);
