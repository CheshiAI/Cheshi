import { expect, test } from 'bun:test';
import { withDOM } from './agent-chats-test-dom';
import { IsolatedTaskCard } from '../frontend/src/features/agent-chats/IsolatedTaskCard';
import { specialistAgent } from './agent-registry-fixtures';
import type { ChatsRequest, RoomMessage } from '../shared/agent-chats';

const agent = { ...specialistAgent(), accountId: 'account', permissions: { fileWrite: true, commandExecution: true }, assignments: [{ workspaceRoot: '/project', instructions: '' }] };
const message: RoomMessage = { id: 'message', roomId: 'room', sender: 'user', recipient: agent.id, kind: 'message', threadId: null,
  text: 'Add a feature', createdAt: '2026-10-09', status: 'unknown', isolated: { scope: ['src/'], check: 'bun test', accountId: 'account', phase: 'unknown',
    taskId: 'task', baseRef: 'refs/heads/main', candidateId: null, workspace: '/managed/worktree', branch: 'worktree/feature/task', commit: null,
    sessionId: 'thread', output: 'Model output', diff: '+feature', error: 'Acknowledgement was lost' } };

test('unknown task shows evidence and inspection, never a success badge or retry action', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    await ui.render(<IsolatedTaskCard message={message} mutate={async request => { requests.push(request); }} />);
    expect(document.body.textContent).toContain('Outcome needs inspection'); expect(document.body.textContent).not.toContain('Verification passed');
    expect(document.querySelector('[aria-label="Isolated task diff"]')?.textContent).toContain('+feature');
    await ui.click('Check saved result'); expect(requests).toEqual([{ action: 'isolated-inspect', roomId: 'room', messageId: 'message' }]);
  });
});
