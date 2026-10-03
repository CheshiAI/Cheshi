import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { specialistAgent } from './agent-registry-fixtures';
import { GoalQuestions } from '../frontend/src/features/agent-chats/GoalQuestions';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import { RoomDialog } from '../frontend/src/features/agent-chats/RoomDialog';
import { AgentTaskResults } from '../frontend/src/features/agents/AgentTaskResults';
import type { ChatsRequest, ChatsSnapshot, ChatTaskTarget } from '../shared/agent-chats';
async function withDOM(run: (ui: { render(node: ReactNode): Promise<void>; click(label: string): Promise<void>; type(label: string, text: string): Promise<void> }) => Promise<void>) {
  const window = new Window();
  const globals = { window, document: window.document, navigator: window.navigator, Node: window.Node, HTMLElement: window.HTMLElement,
    HTMLDialogElement: window.HTMLDialogElement, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div'); document.body.append(container);
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container);
  try { await run({ render: async node => { await act(async () => root.render(node)); }, click: async label => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label);
    if (!button) throw new Error(`Missing button ${label}`); await act(async () => button.click());
  }, type: async (label, text) => {
    const input = document.querySelector(`[aria-label="${label}"]`) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, text); input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    });
  } }); } finally {
    await act(async () => root.unmount()); await window.happyDOM.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
const snapshot = (): ChatsSnapshot => ({ rooms: [{ id: 'room', workspace: '/project', name: 'Login', engineId: 'docker:test', defaultAgentId: 'dev',
  members: [{ id: 'dev', accountId: 'account', name: 'Development' }], createdAt: '2026-10-03T00:00:00Z' }], messages: [
  { id: 'goal', roomId: 'room', threadId: null, sender: 'user', recipient: 'dev', kind: 'goal', text: 'Build login', createdAt: '2026-10-03T00:00:00Z', taskId: 'task', status: 'waiting' },
  { id: 'reply', roomId: 'room', threadId: 'goal', sender: 'dev', recipient: null, kind: 'message', text: 'Waiting for design', createdAt: '2026-10-03T00:01:00Z', taskId: 'task', status: 'waiting' },
] });
test('Chats shows room goals, opens a thread and task details, and preserves thread on return', async () => {
  await withDOM(async ui => {
    const api = { request: async () => snapshot() }, opened: ChatTaskTarget[] = [];
    const render = (active: boolean) => ui.render(<ChatsView active={active} api={api} onOpenAgents={() => {}} onOpenTask={target => opened.push(target)} />);
    await render(true);
    expect(document.body.textContent).toContain('Build login');
    expect(document.body.textContent).not.toContain('Waiting for design');
    await ui.click('Open goal thread · 1');
    expect(document.body.textContent).toContain('Waiting for design');
    await ui.click('Task details');
    expect(opened[0]).toEqual({ roomId: 'room', threadId: 'goal', agentId: 'dev', engineId: 'docker:test', taskId: 'task' });
    await render(false); await render(true);
    expect(document.body.textContent).toContain('Waiting for design');
    await ui.click('Back to room');
    expect(document.body.textContent).not.toContain('Waiting for design');
  });
});
test('send failure keeps the draft and retry uses the same message identity', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = []; let fail = true;
    const api = { request: async (request: ChatsRequest) => {
      if (request.action === 'send') { requests.push(request); if (fail) throw new Error('Save failed'); }
      return snapshot();
    } };
    await ui.render(<ChatsView active api={api} onOpenAgents={() => {}} onOpenTask={() => {}} />);
    await ui.type('Message', 'Hello'); await ui.click('Send');
    expect(requests).toHaveLength(1);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Hello');
    fail = false; await ui.click('Send');
    expect(requests[1]).toEqual(requests[0]);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('');
  });
});
test('linked task detail opens when its delayed worker results arrive and returns to Chats', async () => {
  await withDOM(async ui => {
    let returned = false;
    const back = () => { returned = true; };
    await ui.render(<AgentTaskResults tasks={[]} requestedTaskId="task" onBackToChats={back} loading={false} running={false} />);
    expect(document.body.textContent).toContain('linked task is not available');
    await ui.render(<AgentTaskResults tasks={[{ id: 'task', prompt: 'Build login', status: 'completed', createdAt: '2026-10-03T00:00:00Z', output: 'Verified login', error: null }]} requestedTaskId="task" onBackToChats={back} loading={false} running />);
    expect(document.body.textContent).toContain('Verified login');
    await ui.click('Back to Chats'); expect(returned).toBe(true);
  });
});


test('new room invites an assigned agent and uses that agent as its default recipient', async () => {
  await withDOM(async ui => {
    const agent = { ...specialistAgent(), name: 'Developer', accountId: 'account', assignments: [{ workspaceRoot: '/project', instructions: '' }] };
    const requests: ChatsRequest[] = [];
    let data: ChatsSnapshot = { rooms: [], messages: [] };
    const api = { request: async (request: ChatsRequest) => {
      requests.push(request);
      if (request.action === 'create') data = { rooms: [{ id: request.id, name: request.name, workspace: '/project', engineId: request.engineId,
        defaultAgentId: request.defaultAgentId, members: [{ id: agent.id, name: agent.name, accountId: 'account' }], createdAt: '2026-10-03T00:00:00Z' }], messages: [] };
      return data;
    } };
    await ui.render(<ChatsView active api={api} registry={{ list: async () => ({ workspaceRoot: '/project', agents: [agent] }), onDidChange: () => () => {} }}
      management={{ engines: async () => ({ engines: [{ id: 'docker:test', name: 'Test engine', supported: true, reason: null }], error: null }) }} onOpenAgents={() => {}} onOpenTask={() => {}} />);
    await ui.click('New room'); await ui.type('Room name', 'Release');
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click()); await ui.click('Create room');
    expect(requests.find(r => r.action === 'create')).toMatchObject({ name: 'Release', members: [agent.id], defaultAgentId: agent.id });
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.body.textContent).toContain('Release');
    await ui.type('Message', '@Stranger hello'); await ui.click('Send');
    expect(requests.some(r => r.action === 'send')).toBe(false);
    expect(document.body.textContent).toContain('invited agent');
    await ui.type('Message', '@Developer hello'); await ui.click('Send');
    expect(requests.find(r => r.action === 'send')).toMatchObject({ recipient: agent.id, goal: false });
  });
});

test.each(['deleted', 'account-replaced'])('room settings retain an unavailable %s participant and allow a new default', async reason => {
  await withDOM(async ui => {
    const room = snapshot().rooms[0]!;
    const newcomer = { ...specialistAgent(), id: 'new', name: 'New agent', accountId: 'new-account' };
    const replacement = { ...specialistAgent(), id: 'dev', name: 'Replacement', accountId: 'other-account' };
    const requests: ChatsRequest[] = [];
    await ui.render(<RoomDialog room={room} agents={reason === 'deleted' ? [newcomer] : [replacement, newcomer]} engines={[]}
      onSave={async request => { requests.push(request); }} onClose={() => {}} />);
    const old = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(old.checked).toBe(true); expect(old.disabled).toBe(true);
    expect(old.closest('label')?.textContent).toContain('Development · Unavailable');
    expect(document.body.textContent).not.toContain('Replacement');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Default agent"]')?.disabled).toBe(true);
    await ui.click('Save participants'); expect(requests).toHaveLength(0);
    const added = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
    await act(async () => added.click());
    await ui.click('Default agent');
    const options = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(options.map(e => e.textContent)).toEqual(['New agent']);
    await ui.click('New agent');
    await ui.click('Save participants');
    expect(requests).toEqual([{ action: 'invite', roomId: 'room', members: ['dev', 'new'], defaultAgentId: 'new' }]);
  });
});

test('room settings recheck a default whose account changes while the dialog is open', async () => {
  await withDOM(async ui => {
    const room = snapshot().rooms[0]!, requests: ChatsRequest[] = [];
    const render = (accountId: string) => ui.render(<RoomDialog room={room} agents={[{ ...specialistAgent(), id: 'dev', name: 'Development', accountId }]} engines={[]}
      onSave={async request => { requests.push(request); }} onClose={() => {}} />);
    await render('account');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Default agent"]')?.disabled).toBe(false);
    await render('replacement');
    expect(document.body.textContent).toContain('Unavailable');
    await ui.click('Save participants'); expect(requests).toHaveLength(0);
    await render('account'); await ui.click('Save participants');
    expect(requests).toHaveLength(1);
  });
});

function recoverySnapshot(block: string | null = null): ChatsSnapshot {
  const data = snapshot();
  Object.assign(data.messages[0]!, { status: 'blocked', goalProgress: { phase: 'blocked', turns: 2, turnLimit: 8,
    progress: 'Requirements reviewed', reason: 'Choose the sign-in method', nextAction: 'Provide the sign-in method', resumeBlocked: block } });
  return data;
}

test('blocked goal displays its progress and sends a follow-up to the same owner and thread', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => { requests.push(request); return recoverySnapshot(); } };
    await ui.render(<ChatsView active api={api} onOpenAgents={() => {}} onOpenTask={() => {}} />);
    await ui.click('Open goal thread · 1');
    const panel = document.querySelector('[aria-label="Goal progress"]');
    expect(panel?.textContent).toContain('Goal · blocked');
    expect(panel?.textContent).toContain('Turns: 2 / 8');
    expect(panel?.textContent).toContain('Requirements reviewed');
    expect(panel?.textContent).toContain('Choose the sign-in method');
    expect(panel?.textContent).toContain('Provide the sign-in method');
    await ui.type('Message', 'Use email sign-in'); await ui.click('Send and resume goal');
    expect(requests.filter(r => r.action === 'send')).toMatchObject([{ roomId: 'room', threadId: 'goal', recipient: null, text: 'Use email sign-in', goal: false }]);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('');
  });
});

test.each(['Execution outcome is unknown.', 'Goal turn limit reached (8/8).', 'Checking the saved goal and worker state.'])('recovery cannot send while blocked: %s', async reason => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => { requests.push(request); return recoverySnapshot(reason); } };
    await ui.render(<ChatsView active api={api} onOpenAgents={() => {}} onOpenTask={() => {}} />);
    await ui.click('Open goal thread · 1'); await ui.type('Message', 'Continue');
    expect(document.querySelector('[aria-label="Goal progress"]')?.textContent).toContain(reason);
    await ui.click('Send');
    expect(requests.some(r => r.action === 'send')).toBe(false);
    // A keyboard form submit must pass the same guard as the disabled button.
    await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(requests.some(r => r.action === 'send')).toBe(false);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Continue');
  });
});

test('recovery save failure preserves draft and retry identity', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = []; let fail = true;
    const api = { request: async (request: ChatsRequest) => {
      if (request.action === 'send') { requests.push(request); if (fail) throw new Error('Save failed'); }
      return recoverySnapshot();
    } };
    await ui.render(<ChatsView active api={api} onOpenAgents={() => {}} onOpenTask={() => {}} />);
    await ui.click('Open goal thread · 1'); await ui.type('Message', 'Use email'); await ui.click('Send and resume goal');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Use email');
    fail = false; await ui.click('Send and resume goal');
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  });
});

test('unknown execution inspection preserves the draft on failure and shows native source after success', async () => {
  await withDOM(async ui => {
    let data = recoverySnapshot('Execution outcome is unknown.'), fail = true;
    data.messages[0]!.status = 'unknown'; data.messages[0]!.goalProgress!.phase = 'unknown';
    const calls: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => {
      calls.push(request);
      if (request.action === 'recover') {
        if (fail) throw new Error('The saved turn has not ended');
        data = recoverySnapshot();
        data.messages[0]!.goalProgress!.recovery = { threadId: 'native-thread', turnId: 'native-turn', status: 'completed', checkedAt: '2026-10-03T00:00:00Z' };
      }
      return structuredClone(data);
    } };
    await ui.render(<ChatsView active api={api} onOpenAgents={() => {}} onOpenTask={() => {}} />);
    await ui.click('Open goal thread · 1'); await ui.type('Message', 'Keep this draft');
    await ui.click('Check execution result');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('has not ended');
    expect(document.querySelector('[aria-label="Goal progress"]')?.textContent).toContain('unknown');
    fail = false; await ui.click('Check execution result');
    expect(calls.filter(c => c.action === 'recover')).toEqual(Array(2).fill({ action: 'recover', roomId: 'room', goalId: 'goal' }));
    expect(calls.some(c => c.action === 'send')).toBe(false);
    expect(document.querySelector('[aria-label="Goal progress"]')?.textContent).toContain('native-turn');
    expect(document.querySelector('[aria-label="Goal progress"]')?.textContent).toContain('Goal · blocked');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
  });
});

test('question cancellation preserves drafts on a racing answer error and retries the same question identity', async () => {
  await withDOM(async ui => {
    const data = snapshot(), requests: ChatsRequest[] = [];
    data.messages[0]!.goalProgress = { phase: 'waiting', turns: 2, turnLimit: 8, progress: '', reason: '', nextAction: '', resumeBlocked: null,
      questions: [{ id: 'question', recipient: 'planner', text: 'Which credentials?', status: 'waiting', closure: null }] };
    let failure = true;
    const api = { request: async (input: ChatsRequest) => {
      if (input.action === 'question') {
        requests.push(input);
        if (failure) throw new Error('An answer already arrived. Refresh the question.');
        data.messages[0]!.goalProgress!.questions![0]!.status = 'closed';
      }
      return structuredClone(data);
    } };
    await ui.render(<ChatsView active api={api} onOpenAgents={() => {}} onOpenTask={() => {}} />);
    await ui.click('Open goal thread · 1'); await ui.type('Message', 'Keep this draft');
    await ui.click('Cancel question');
    expect(document.body.textContent).toContain('answer already arrived');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
    failure = false; await ui.click('Cancel question');
    expect(requests).toEqual(Array(2).fill({ action: 'question', roomId: 'room', goalId: 'goal', questionId: 'question', recipient: null }));
    expect(document.body.textContent).toContain('0 waiting');
    expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Cancel question')).toBe(false);
  });
});


test('question reassignment chooses an invited alternative and submits the existing question identity', async () => {
  await withDOM(async ui => {
    const calls: unknown[] = [];
    const props = { questions: [{ id: 'question', recipient: 'planner', text: 'Which credentials?', status: 'waiting' as const, closure: null }],
      members: [{ id: 'planner', name: 'Planner', accountId: 'a' }, { id: 'designer', name: 'Designer', accountId: 'b' }],
      onChange: (id: string, recipient: string | null) => { calls.push({ id, recipient }); } };
    await ui.render(<GoalQuestions {...props} disabled={false} />);
    await ui.click('Reassign question'); expect(calls).toHaveLength(0);
    await ui.click('New question recipient'); await ui.click('Designer'); await ui.click('Reassign question');
    expect(calls).toEqual([{ id: 'question', recipient: 'designer' }]);
    await ui.render(<GoalQuestions {...props} disabled />);
    await ui.click('Reassign question'); await ui.click('Cancel question'); expect(calls).toHaveLength(1);
  });
});
