import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { withDOM } from './agent-chats-test-dom';
import { TaskWorkspace } from '../frontend/src/features/agent-chats/TaskWorkspace';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatsRequest, RoomMessage } from '../shared/agent-chats';
import type { WorkerWorkspaceInspection } from '../shared/worker-workspace';
import { specialistAgent } from './agent-registry-fixtures';

const message: RoomMessage = { id: 'request', roomId: 'room', threadId: null, sender: 'user', recipient: 'dev', taskId: 'first',
  text: 'Change the feature', kind: 'message', createdAt: '2026-10-10T00:00:00Z' };
const inspection: WorkerWorkspaceInspection = { state: 'ready', workspace: '/retained/task-first', branch: 'worktree/feature/task-first',
  baseCommit: 'a'.repeat(40), baseBranch: 'refs/heads/feature/chats', kind: 'task', checkedAt: '2026-10-10T00:00:00Z',
  changes: [{ path: 'feature.ts', status: 'M' }], diff: '-old\n+new', truncated: false, error: null };

test('worktree details load only on demand, use the exact message, show changes, copy path and open the folder', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [], copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
    function Harness() {
      const [saved, setSaved] = useState(message);
      return <TaskWorkspace message={saved} owner="Cheshi-Development" mutate={async input => {
        requests.push(input); setSaved({ ...message, workspaceInspection: inspection });
      }} />;
    }
    await ui.render(<Harness />);
    expect(requests).toHaveLength(0);
    const toggle = document.querySelector<HTMLElement>('summary')!;
    await act(async () => toggle.click());
    expect(requests).toEqual([{ action: 'workspace-inspect', roomId: 'room', messageId: 'request' }]);
    for (const text of ['first', inspection.workspace!, inspection.branch!, inspection.baseCommit!, 'feature/chats', 'feature.ts', '+new']) expect(document.body.textContent).toContain(text);
    await ui.click('Copy path'); expect(copied).toEqual(['/retained/task-first']);
    await ui.click('Open folder'); expect(requests.at(-1)).toEqual({ action: 'workspace-open', roomId: 'room', messageId: 'request' });
    await ui.click('Refresh worktree'); expect(requests.at(-1)?.action).toBe('workspace-inspect');
    const count = requests.length;
    await act(async () => toggle.click());
    expect(document.querySelector('details')?.open).toBe(false);
    expect(requests).toHaveLength(count);
    await act(async () => toggle.click());
    expect(document.querySelector('details')?.open).toBe(true);
    expect(requests).toHaveLength(count + 1);
  });
});

test.each(['missing', 'unavailable'] as const)('%s worktree shows retained identity and blocks folder opening without claiming clean files', async state => {
  await withDOM(async ui => {
    await ui.render(<TaskWorkspace message={{ ...message, workspaceInspection: { ...inspection, state, baseBranch: null, changes: [], error: 'Workspace needs inspection.' } }}
      owner="Cheshi-Development" mutate={async () => {}} />);
    await act(async () => document.querySelector<HTMLElement>('summary')!.click());
    expect(document.body.textContent).toContain('Recorded branch');
    expect(document.body.textContent).toContain('Not recorded');
    expect(document.body.textContent).toContain('Workspace needs inspection.');
    expect(document.body.textContent).not.toContain('No changed files.');
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Open folder'))!;
    expect(open.disabled).toBe(true);
  });
});

test('inspection failures remain visible and can be retried', async () => {
  await withDOM(async ui => {
    let calls = 0;
    await ui.render(<TaskWorkspace message={message} owner="Developer" mutate={async () => { calls++; throw new Error('Workspace is unavailable'); }} />);
    await act(async () => document.querySelector<HTMLElement>('summary')!.click());
    expect(document.body.textContent).toContain('Workspace is unavailable');
    await ui.click('Refresh worktree'); expect(calls).toBe(2);
  });
});

test('Worker shows one worktree per producing task, including peer tasks, without changing the composer draft', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const agents = ['dev', 'peer'].map(id => ({ ...specialistAgent(), id, name: id, accountId: 'account', assignments: [{ workspaceRoot: '/project', instructions: '' }] }));
    const data = { rooms: [{ id: 'room', workspace: '/project', name: 'Development', engineId: 'docker:test', defaultAgentId: 'dev',
      members: agents.map(({ id, name, accountId }) => ({ id, name, accountId })), createdAt: message.createdAt }], messages: [message,
      { ...message, id: 'follow-up', text: 'Same task follow-up' },
      { ...message, id: 'second', taskId: 'second' },
      { ...message, id: 'peer-task', taskId: undefined, sender: 'dev', recipient: 'peer', relatedTask: { agentId: 'peer', taskId: 'review' } }] };
    await ui.render(<ChatsView active registry={{ list: async () => ({ workspaceRoot: '/project', agents }), onDidChange: () => () => {} }}
      api={{ request: async input => { requests.push(input); return data; } }} />);
    expect(document.querySelectorAll('[aria-label^="Worktree for"]')).toHaveLength(3);
    await ui.type('Message', 'Keep my draft');
    const section = document.querySelector('[data-message-id="peer-task"]')!;
    await act(async () => section.querySelector<HTMLElement>('summary')!.click());
    expect(requests.at(-1)).toEqual({ action: 'workspace-inspect', roomId: 'room', messageId: 'peer-task' });
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep my draft');
    expect(requests.some(r => r.action === 'send')).toBe(false);
  });
});
