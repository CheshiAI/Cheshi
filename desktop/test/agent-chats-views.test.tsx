import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { act, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { withDOM } from './agent-chats-test-dom';
import { specialistAgent } from './agent-registry-fixtures';
import { GoalQuestions } from '../frontend/src/features/agent-chats/GoalQuestions';
import { ChatsView as WorkerView } from '../frontend/src/features/agent-chats/ChatsView';
import { VoiceDialog } from '../frontend/src/features/agent-chats/VoiceDialog';
import type { VoiceRequest, VoiceSnapshot } from '../shared/agent-voice';
import { AgentTaskResults } from '../frontend/src/features/agents/AgentTaskResults';
import { IntegrationDetail } from '../frontend/src/features/agents/IntegrationDetail';
import { VerificationMessage } from '../frontend/src/features/agents/VerificationMessage';
import type { ChatsRequest, ChatsSnapshot } from '../shared/agent-chats';
import type { IntegrationSummary } from '../shared/agent-work';
const registeredHomies = { list: async () => ({ workspaceRoot: '/project', agents: ['dev', 'planner'].map(id => ({
  ...specialistAgent(), id, name: id === 'dev' ? 'Development' : 'Planning Homie',
  accountId: id === 'dev' ? 'account' : 'planner-account', assignments: [{ workspaceRoot: '/project', instructions: '' }],
})) }), onDidChange: () => () => {} };
function ChatsView(props: ComponentProps<typeof WorkerView>) {
  return <WorkerView registry={registeredHomies} {...props} />;
}
const snapshot = (): ChatsSnapshot => ({ rooms: [{ id: 'room', workspace: '/project', name: 'Login', engineId: 'docker:test', defaultAgentId: 'dev',
  members: [{ id: 'dev', accountId: 'account', name: 'Development' }], createdAt: '2026-10-03T00:00:00Z' }], messages: [
  { id: 'goal', roomId: 'room', threadId: null, sender: 'user', recipient: 'dev', kind: 'goal', text: 'Build login', createdAt: '2026-10-03T00:00:00Z', taskId: 'task', status: 'waiting' },
  { id: 'reply', roomId: 'room', threadId: 'goal', sender: 'dev', recipient: null, kind: 'message', text: 'Waiting for design', createdAt: '2026-10-03T00:01:00Z', taskId: 'task', status: 'waiting' },
] });
test('Worker opens Homie management from its right tools rail and participants and preserves the hidden conversation', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [], selections: (string | undefined)[] = [];
    const api = { request: async (request: ChatsRequest) => { requests.push(request); return snapshot(); } };
    const render = (active = true) => ui.render(<ChatsView active={active} api={api} onManageHomies={id => selections.push(id)} />);
    await render();
    await ui.type('Message', 'Keep the room draft');
    const timeline = document.querySelector('[aria-label="Room messages"]');
    expect(document.querySelector('[aria-label="Worker rooms"] [aria-label="Manage Homies"]')).toBeNull();
    expect(document.querySelector('[aria-label="Worker"] header [aria-label="Manage Homies"]')).toBeNull();
    const manage = document.querySelector<HTMLButtonElement>('[aria-label="Room tools"] [aria-label="Manage Homies"]')!;
    await act(async () => manage.click());
    await ui.click('Manage Homie: Development');
    expect(selections).toEqual([undefined, 'dev']);
    await render(false);
    expect(document.querySelector<HTMLElement>('[aria-label="Worker"]')?.hidden).toBe(true);
    await render();
    expect(document.querySelector<HTMLElement>('[aria-label="Worker"]')?.hidden).toBe(false);
    expect(document.querySelector('[aria-label="Room messages"]')).toBe(timeline);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep the room draft');
    expect(requests.every(request => request.action === 'list')).toBe(true);
  });
});
test('Worker offers Homie management before a room exists with the room sidebar hidden', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    let opened = 0;
    await ui.render(<ChatsView active sidebarTarget={null} onManageHomies={() => { opened++; }}
      api={{ request: async request => { requests.push(request); return { rooms: [], messages: [] }; } }} />);
    expect(document.querySelector('[aria-label="Worker rooms"]')).toBeNull();
    await ui.click('Manage Homies');
    expect(opened).toBe(1);
    expect(requests.every(request => request.action === 'list')).toBe(true);
  });
});
test('phone dialog binds pairing to this room and requires explicit approval before showing a linked device', async () => {
  await withDOM(async ui => {
    const requests: VoiceRequest[] = [];
    let state: VoiceSnapshot = { configured: true, connected: true, calling: false, error: null, link: null, expiresAt: null, pending: null, devices: [] };
    const api = { request: async (request: VoiceRequest) => {
      requests.push(request);
      if (request.action === 'pair') state = { ...state, link: 'https://connect.example/#host=test&pair=fixture', expiresAt: Date.now() + 120000, pending: { id: 'pending', name: 'Phone', code: '123456' } };
      if (request.action === 'approve') state = { ...state, link: null, pending: null, devices: [{ id: 'device', name: 'Phone', roomId: 'room', roomName: 'Login' }] };
      if (request.action === 'revoke') state = { ...state, devices: [] };
      return state;
    } };
    await ui.render(<VoiceDialog roomId="room" api={api} onClose={() => {}} />);
    await ui.click('Link a phone to this room');
    expect(requests.at(-1)).toEqual({ action: 'pair', roomId: 'room' });
    expect(document.body.textContent).toContain('123456'); expect(state.devices).toHaveLength(0);
    await ui.click('Codes match · Approve'); expect(requests.at(-1)).toEqual({ action: 'approve', id: 'pending' });
    expect(document.querySelector('[aria-label="Phone pairing link"]')).toBeNull();
    await ui.click('Unlink'); expect(requests.at(-1)).toEqual({ action: 'revoke', id: 'device' });
  });
});
test('header phone opens its dialog without a separate participants popup and preserves the draft', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => { requests.push(request); return snapshot(); } };
    await ui.render(<ChatsView active api={api} />);
    const rail = document.querySelector('[aria-label="Room tools"]')!;
    expect([...rail.querySelectorAll('button')].map(button => button.getAttribute('aria-label')))
      .toEqual([]);
    expect(document.querySelector('[aria-label="Worker"] header [aria-label="Phone calls"]')).not.toBeNull();
    await ui.type('Message', 'Keep this draft');
    const timeline = document.querySelector('[aria-label="Room messages"]');
    for (const label of ['Phone calls']) {
      await ui.click(label);
      const dialog = document.querySelector('dialog')!;
      expect(dialog.textContent).toContain(label);
      await ui.click('Close dialog');
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.querySelector('[aria-label="Room messages"]')).toBe(timeline);
      expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
    }
    expect(requests.every(request => request.action === 'list')).toBe(true);
  });
});
test('Chats shows the entire room timeline without thread or task navigation and retains reply context', async () => {
  await withDOM(async ui => {
    const api = { request: async () => snapshot() };
    const render = (active: boolean) => ui.render(<ChatsView active={active} api={api} />);
    await render(true);
    const timeline = document.querySelector('[aria-label="Room messages"]')!;
    expect(timeline.textContent).toContain('Build login'); expect(timeline.textContent).toContain('Waiting for design');
    expect(document.body.textContent).not.toContain('Open goal thread');
    expect(document.body.textContent).not.toContain('Task details');
    await ui.click('Reply to Build login'); await ui.type('Message', 'Email only');
    await render(false); await render(true);
    expect(document.querySelector('[aria-label="Reply context"]')?.textContent).toContain('Build login');
    await ui.click('Cancel reply');
    expect(document.querySelector('[aria-label="Room messages"]')?.textContent).toContain('Waiting for design');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Email only');
  });
});
test('room composer reconnects shared blur and resizes its overlay without moving a reader away from earlier messages', async () => {
  await withDOM(async ui => {
    const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
    class Observer implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { observers.set(this, { callback, targets: new Set() }); }
      observe(target: Element) { observers.get(this)!.targets.add(target); }
      unobserve(target: Element) { observers.get(this)!.targets.delete(target); }
      disconnect() { observers.delete(this); }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
    const resize = async (target: Element) => {
      await act(async () => {
        for (const [observer, entry] of observers) if (entry.targets.has(target)) entry.callback([], observer);
      });
    };
    const data = snapshot(); data.rooms.push({ ...data.rooms[0]!, id: 'second', name: 'Planning' });
    await ui.render(<ChatsView active api={{ request: async () => data }} />);
    const panel = document.querySelector('[aria-label="Room composer"]')!.parentElement!;
    const area = panel.closest('footer')!, content = area.parentElement!;
    const timeline = document.querySelector('[aria-label="Room messages"]') as HTMLElement;
    expect(panel.getAttribute('data-regional-blur-surface')).toBe('true');
    expect(timeline.contains(panel)).toBe(false);
    expect(content.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('16');
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 500 },
      clientWidth: { configurable: true, value: 640 },
    });
    let height = 180;
    area.getBoundingClientRect = () => ({ x: 0, y: 320, width: 640, height, top: 320, right: 640, bottom: 320 + height, left: 0, toJSON() { return {}; } });
    await resize(area);
    expect(content.style.getPropertyValue('--composer-overlay-height')).toBe('180px');
    expect(content.style.getPropertyValue('--chat-viewport-width')).toBe('640px');
    expect(timeline.scrollTop).toBe(1200);
    timeline.scrollTop = 100; timeline.dispatchEvent(new window.Event('scroll', { bubbles: true }));
    height = 260; await resize(area);
    expect(content.style.getPropertyValue('--composer-overlay-height')).toBe('260px');
    expect(timeline.scrollTop).toBe(100);
    height = 0; await resize(area);
    expect(content.style.getPropertyValue('--composer-overlay-height')).toBe('260px');
    expect(timeline.scrollTop).toBe(100);
    height = 280; await resize(area);
    expect(content.style.getPropertyValue('--composer-overlay-height')).toBe('280px');
    await ui.type('Message', 'Keep this draft');
    await ui.click('Planning');
    expect([...observers.values()].some(entry => entry.targets.has(area))).toBe(false);
    expect(panel.hasAttribute('data-regional-blur-surface')).toBe(false);
    expect(document.querySelector('[aria-label="Room composer"]')?.parentElement?.getAttribute('data-regional-blur-surface')).toBe('true');
    await ui.click('Login');
    expect((document.querySelector('[aria-label="Room messages"]') as HTMLElement).scrollTop).toBe(100);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
  });
});

test('send failure keeps the draft and retry uses the same message identity', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = []; let fail = true;
    const api = { request: async (request: ChatsRequest) => {
      if (request.action === 'send') { requests.push(request); if (fail) throw new Error('Save failed'); }
      return snapshot();
    } };
    await ui.render(<ChatsView active api={api} />);
    await ui.type('Message', 'Hello'); await ui.click('Send message');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ recipient: 'dev', threadId: null });
    expect(document.querySelector('[aria-label="Message recipient"]')).toBeNull();
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Hello');
    fail = false; await ui.click('Send message');
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
    await ui.click('Back to Worker'); expect(returned).toBe(true);
  });
});


test('shared composer grows with the draft, caps its height and resets after sending', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => { requests.push(request); return snapshot(); } };
    await ui.render(<ChatsView active api={api} />);
    const input = document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
    const button = document.querySelector('[aria-label="Send message"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    let height = 300;
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => height });
    await ui.type('Message', 'First line\nSecond line');
    expect(input.style.height).toBe('180px');
    expect(button.disabled).toBe(false);
    height = 44;
    await ui.click('Send message');
    expect(requests.filter(request => request.action === 'send')).toMatchObject([{ text: 'First line\nSecond line', recipient: 'dev' }]);
    expect(input.value).toBe('');
    expect(input.style.height).toBe('44px');
    expect(button.disabled).toBe(true);
  });
});
test('composer previews natural calls and selected mentions, and replies keep their recipient', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => { if (request.action === 'send') requests.push(request); return snapshot(); } };
    await ui.render(<ChatsView active api={api} />);
    await ui.type('Message', 'Development 호출하여 로그인 만들어줘');
    expect(document.querySelector('[aria-label="Delivery target"]')?.textContent).toBe('To: Development');
    await ui.click('Send message'); expect(requests.at(-1)).toMatchObject({ recipient: 'dev' });
    await ui.type('Message', '@Dev'); await ui.click('@Development');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('@Development ');
    await ui.type('Message', 'Development가 담당합니다');
    expect(document.querySelector('[aria-label="Delivery target"]')?.textContent).toBe('To: Development');
    await ui.click('Send message'); expect(requests.at(-1)).toMatchObject({ recipient: 'dev' });
    await ui.click('Reply to Build login'); await ui.type('Message', 'Use email');
    expect(document.querySelector('[aria-label="Delivery target"]')?.textContent).toBe('To: Development');
    await ui.click('Send message'); expect(requests.at(-1)).toMatchObject({ recipient: 'dev', replyTo: 'goal' });
  });
});
test('new room invites an assigned agent and delivers plain messages to its default Homie', async () => {
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
      management={{ engines: async () => ({ engines: [{ id: 'docker:test', name: 'Test engine', supported: true, reason: null }], error: null }) }} />);
    await ui.click('New room'); await ui.type('Room name', 'Release');
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click()); await ui.click('Create room');
    expect(requests.find(r => r.action === 'create')).toMatchObject({ name: 'Release', members: [agent.id], defaultAgentId: agent.id });
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.body.textContent).toContain('Release');
    await ui.type('Message', '@Stranger hello'); await ui.click('Send message');
    expect(requests.some(r => r.action === 'send')).toBe(false);
    expect(document.body.textContent).toContain('invited agent');
    expect(document.body.textContent).not.toContain('recipient menu');
    await ui.type('Message', 'hello'); await ui.click('Send message');
    expect(requests.find(r => r.action === 'send')).toMatchObject({ recipient: agent.id, goal: false, automatic: true });
    expect(document.querySelector('[aria-label="Message type"]')).toBeNull();
    expect(document.body.textContent).not.toContain('New goal');
  });
});

function recoverySnapshot(block: string | null = null): ChatsSnapshot {
  const data = snapshot();
  Object.assign(data.messages[0]!, { status: 'blocked', goalProgress: { phase: 'blocked', turns: 2,
    progress: 'Requirements reviewed', reason: 'Choose the sign-in method', nextAction: 'Provide the sign-in method', resumeBlocked: block } });
  return data;
}
test('Chats and task details inspect exact application identity without sending a prompt and retain errors and drafts', async () => {
  await withDOM(async ui => {
    const data = recoverySnapshot(), calls: ChatsRequest[] = [];
    const integration: IntegrationSummary = { version: 1, id: 'a'.repeat(64), taskId: 'task', roomId: 'room', requestIds: ['b'.repeat(64)],
      status: 'prepared', candidateHash: 'c'.repeat(64), files: [], issues: [], createdAt: '2026-10-04T00:00:00Z', checkedAt: '2026-10-04T00:00:00Z',
      application: { id: 'd'.repeat(64), candidateId: 'a'.repeat(64), hash: 'c'.repeat(64), verificationId: 'e'.repeat(64), status: 'interrupted',
        updatedAt: '2026-10-04T00:00:00Z', files: [{ path: 'login.ts', before: 'f'.repeat(64), after: 'c'.repeat(64), phase: 'writing', observed: 'before' }] } };
    data.messages[0]!.goalProgress!.integration = integration;
    const api = { request: async (request: ChatsRequest) => { calls.push(request); if (request.action === 'application-inspect') throw new Error('Application lock belongs to another operation.'); return data; } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login'); await ui.type('Message', 'Keep this draft'); await ui.click('Inspect application');
    expect(calls.filter(c => c.action !== 'list')).toEqual([{ action: 'application-inspect', roomId: 'room', goalId: 'goal', candidateId: integration.id, hash: integration.candidateHash! }]);
    expect(document.body.textContent).toContain('Application lock belongs to another operation.');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
    const inspected: string[][] = [];
    for (const status of ['unknown', 'interrupted'] as const) {
      await ui.render(<AgentTaskResults tasks={[{ id: 'task', roomId: 'room', prompt: 'Implement login', status, createdAt: integration.createdAt, output: '', error: null,
        inspection: { integration, finishedAt: null, threadId: 'native', conversation: 'task', goal: null, messages: [], evidence: [], error: null } }]}
        requestedTaskId="task" loading={false} running onInspectApplication={(...args) => inspected.push(args)} />);
      const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Inspect application')!;
      expect(button.disabled).toBe(status === 'unknown'); await ui.click('Inspect application');
    }
    expect(inspected).toEqual([['task', 'room', integration.id, integration.candidateHash!]]);
  });
});

test('Chats and task details expose integration conflicts and hashes without an apply control', async () => {
  await withDOM(async ui => {
    const data = recoverySnapshot(), integration = { version: 1 as const, id: 'a'.repeat(64), taskId: 'task', roomId: 'room', requestIds: ['b'.repeat(64)],
      status: 'conflict' as const, candidateHash: null, files: [], issues: [{ kind: 'proposal_conflict' as const, path: 'login.ts', requestIds: ['b'.repeat(64)] }],
      createdAt: '2026-10-04T00:00:00Z', checkedAt: '2026-10-04T00:00:00Z' };
    data.messages[0]!.goalProgress!.integration = integration;
    await ui.render(<ChatsView active api={{ request: async () => data }} />);
    await ui.click('Reply to Build login');
    expect(document.querySelector('[aria-label="Application attention"]')?.textContent).toContain('Integration conflict');
    expect(document.body.textContent).toContain('login.ts');
    await ui.render(<AgentTaskResults tasks={[{ id: 'task', prompt: 'Implement login', status: 'interrupted', createdAt: integration.createdAt, output: '', error: null,
      inspection: { integration: { ...integration, status: 'prepared', candidateHash: 'c'.repeat(64), issues: [], files: [{ path: 'login.ts', before: null, sha256: 'd'.repeat(64) }] },
        finishedAt: null, threadId: 'native', conversation: 'task', goal: null, messages: [], evidence: [], error: null } }]}
      requestedTaskId="task" loading={false} running={false} />);
    const panel = document.querySelector('[aria-label="Integration candidate"]');
    expect(panel?.textContent).toContain('Integration candidate prepared');
    expect(panel?.textContent).toContain('Not applied to project');
    expect(panel?.textContent).toContain('d'.repeat(64));
    expect(panel?.querySelectorAll('button')).toHaveLength(0);
  });
});

test('candidate verification shows pending and stale results with receipts, without exposing snapshot bodies', async () => {
  await withDOM(async ui => {
    const candidate = { id: 'a'.repeat(64), hash: 'b'.repeat(64) };
    const result = { candidate, verdicts: [{ criterion: 'Login works', verdict: 'pass' as const, reason: 'Tests passed', evidenceIds: ['file', 'check'] }],
      evidence: [{ id: 'check', kind: 'command' as const, detail: 'bun test login.test.ts', output: '3 pass', exitCode: 0, successful: true }] };
    const integration = { version: 1 as const, id: candidate.id, taskId: 'task', roomId: 'room', requestIds: ['c'.repeat(64)],
      status: 'prepared' as const, candidateHash: candidate.hash, files: [], issues: [], createdAt: '2026-10-04T00:00:00Z', checkedAt: '2026-10-04T00:00:00Z' };
    for (const status of ['pending', 'pass', 'fail', 'inconclusive', 'stale'] as const) {
      await ui.render(<IntegrationDetail integration={{ ...integration, verification: { status, requestId: 'd'.repeat(64), agentId: 'reviewer', result: status === 'pending' ? null : result } }} />);
      expect(document.body.textContent).toContain(`Independent verification: ${status}`);
      expect(document.body.textContent).toContain('Not applied to project');
      if (status === 'stale') expect(document.body.textContent).toContain('do not establish a pass');
    }
    await ui.render(<VerificationMessage kind="verification_request" text={JSON.stringify({ goal: 'Verify', criteria: ['Login works'],
      artifacts: [{ path: 'deleted.ts', sha256: null }], candidate: { ...candidate, files: [{ path: 'deleted.ts', content: 'SECRET_SNAPSHOT_BODY' }] } })} />);
    expect(document.body.textContent).toContain(candidate.hash);
    expect(document.body.textContent).toContain('deleted.ts');
    expect(document.querySelector('[aria-label="Requested file hash"] code')?.textContent).toBe('Absent');
    expect(document.body.textContent).not.toContain('SECRET_SNAPSHOT_BODY');
    await ui.render(<VerificationMessage kind="verification_result" text={JSON.stringify(result)} />);
    expect(document.body.textContent).toContain('bun test login.test.ts');
    expect(document.body.textContent).toContain('3 pass');
  });
});

test('application status distinguishes interrupted files and project verification from candidate verification', async () => {
  await withDOM(async ui => {
    const id = 'a'.repeat(64), hash = 'b'.repeat(64), applicationId = 'c'.repeat(64);
    const result = { candidate: { id, hash, applicationId }, verdicts: [{ criterion: 'Login works', verdict: 'pass' as const, reason: 'Project tests passed', evidenceIds: ['check'] }],
      evidence: [{ id: 'check', kind: 'command' as const, detail: 'bun test login.test.ts', output: 'project pass', exitCode: 0, successful: true }] };
    const integration = { version: 1 as const, id, taskId: 'task', roomId: 'room', requestIds: ['d'.repeat(64)], status: 'prepared' as const,
      candidateHash: hash, files: [], issues: [], createdAt: '2026-10-04T00:00:00Z', checkedAt: '2026-10-04T00:00:00Z' };
    for (const status of ['applied', 'interrupted', 'conflict', 'aborted'] as const) {
      const observed = status === 'aborted' ? 'before' : status === 'conflict' ? 'changed' : 'after';
      await ui.render(<IntegrationDetail integration={{ ...integration, status: status === 'applied' ? 'prepared' : 'stale',
        issues: status === 'conflict' ? [{ kind: 'source_changed', path: null, requestIds: integration.requestIds }] : [],
        application: { id: applicationId, candidateId: id, hash, status,
        verificationId: 'e'.repeat(64), updatedAt: integration.checkedAt, files: [{ path: 'login.ts', before: 'f'.repeat(64), after: hash, phase: 'written', observed }] },
        projectVerification: { requestId: 'f'.repeat(64), agentId: 'verifier', status: status === 'applied' ? 'pass' : 'stale', result } }} />);
      expect(document.body.textContent).toContain(`Project application · ${status}`);
      expect(document.body.textContent).toContain(`login.ts · written · ${observed}`);
      expect(document.body.textContent).toContain('does not retry writes');
      expect(document.body.textContent).toContain(status === 'applied' ? 'Project verification: pass' : 'Project verification: stale');
      if (status === 'conflict') expect(document.body.textContent).toContain('Original file changed since delegation');
      else expect(document.body.textContent).not.toContain('Original file changed since delegation');
      if (status === 'aborted') expect(document.body.textContent).toContain('Application aborted · Original files match the pre-application snapshot');
      if (status === 'interrupted') expect(document.body.textContent).toContain('Application interrupted · Inspect file states before continuing');
    }
    await ui.render(<VerificationMessage kind="verification_result" text={JSON.stringify(result)} />);
    expect(document.body.textContent).toContain(`Project application: ${applicationId}`);
    expect(document.body.textContent).not.toContain('Not applied to project');
  });
});

test('blocked goal keeps reports out of the timeline and sends a follow-up to its owner', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => { requests.push(request); return recoverySnapshot(); } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login');
    const timeline = document.querySelector('[aria-label="Room messages"]')!;
    expect(timeline.textContent).not.toContain('Turns:');
    expect(timeline.textContent).not.toContain('Work update');
    expect(timeline.querySelector('[aria-label="Goal progress"]')).toBeNull();
    await ui.type('Message', 'Use email sign-in'); await ui.click('Send message');
    expect(requests.filter(r => r.action === 'send')).toMatchObject([{ roomId: 'room', threadId: 'goal', recipient: 'dev', text: 'Use email sign-in', goal: false }]);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('');
  });
});

test.each(['Execution outcome is unknown.', 'Checking the saved goal and worker state.'])('recovery cannot send while blocked: %s', async reason => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = [];
    const api = { request: async (request: ChatsRequest) => { requests.push(request); return recoverySnapshot(reason); } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login'); await ui.type('Message', 'Continue');
    expect(document.querySelector('[aria-label="Room composer"]')?.textContent).toContain(reason);
    await ui.click('Send message');
    expect(requests.some(r => r.action === 'send')).toBe(false);
    // A keyboard form submit must pass the same guard as the disabled button.
    await act(async () => document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(requests.some(r => r.action === 'send')).toBe(false);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Continue');
  });
});

test('a leading mention can address an invited peer while the goal owner cannot resume', async () => {
  await withDOM(async ui => {
    const data = recoverySnapshot('Execution outcome is unknown.'), requests: ChatsRequest[] = [];
    data.rooms[0]!.members.push({ id: 'planner', name: 'Planning Homie', accountId: 'planner-account' });
    const api = { request: async (request: ChatsRequest) => { requests.push(request); return data; } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login');
    await ui.type('Message', '@Planning Homie clarify the requirements'); await ui.click('Send message');
    expect(requests.filter(r => r.action === 'send')).toMatchObject([{ recipient: 'planner', threadId: 'goal' }]);
    await ui.click('Reply to Build login');
    await ui.type('Message', '@Development continue'); await ui.click('Send message');
    expect(requests.filter(r => r.action === 'send')).toHaveLength(1);
  });
});

test('recovery save failure preserves draft and retry identity', async () => {
  await withDOM(async ui => {
    const requests: ChatsRequest[] = []; let fail = true;
    const api = { request: async (request: ChatsRequest) => {
      if (request.action === 'send') { requests.push(request); if (fail) throw new Error('Save failed'); }
      return recoverySnapshot();
    } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login'); await ui.type('Message', 'Use email'); await ui.click('Send message');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Use email');
    fail = false; await ui.click('Send message');
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
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login'); await ui.type('Message', 'Keep this draft');
    await ui.click('Check execution result');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('has not ended');
    expect(document.querySelector('[aria-label="Room composer"]')?.textContent).toContain('Execution outcome is unknown');
    fail = false; await ui.click('Check execution result');
    expect(calls.filter(c => c.action === 'recover')).toEqual(Array(2).fill({ action: 'recover', roomId: 'room', goalId: 'goal' }));
    expect(calls.some(c => c.action === 'send')).toBe(false);
    expect(document.querySelector('[aria-label="Room messages"]')?.textContent).not.toContain('native-turn');
    expect(document.querySelector('[aria-label="Delivery target"]')?.textContent).toContain('Send to resume this goal');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
  });
});

test('question cancellation preserves drafts on a racing answer error and retries the same question identity', async () => {
  await withDOM(async ui => {
    const data = snapshot(), requests: ChatsRequest[] = [];
    data.messages[0]!.goalProgress = { phase: 'waiting', turns: 2, progress: '', reason: '', nextAction: '', resumeBlocked: null,
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
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login'); await ui.type('Message', 'Keep this draft');
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
      onDeadline: () => {}, onChange: (id: string, recipient: string | null) => { calls.push({ id, recipient }); } };
    await ui.render(<GoalQuestions {...props} disabled={false} />);
    await ui.click('Reassign question'); expect(calls).toHaveLength(0);
    await ui.click('New question recipient'); await ui.click('Designer'); await ui.click('Reassign question');
    expect(calls).toEqual([{ id: 'question', recipient: 'designer' }]);
    await ui.render(<GoalQuestions {...props} disabled />);
    await ui.click('Reassign question'); await ui.click('Cancel question'); expect(calls).toHaveLength(1);
  });
});

test('deadline edits await acknowledgement, preserve drafts on failure and send canonical UTC or null', async () => {
  await withDOM(async ui => {
    const data = snapshot(), requests: ChatsRequest[] = [];
    data.messages[0]!.goalProgress = { phase: 'waiting', turns: 2, progress: '', reason: '', nextAction: '', resumeBlocked: null,
      questions: [{ id: 'question', recipient: 'planner', text: 'Which credentials?', status: 'waiting', closure: null }] };
    let failure = true;
    const api = { request: async (input: ChatsRequest) => {
      if (input.action === 'question-deadline') {
        requests.push(input);
        if (failure) throw new Error('Worker unavailable.');
        data.messages[0]!.goalProgress!.questions![0]!.expiresAt = input.expiresAt;
      }
      return structuredClone(data);
    } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login'); await ui.type('Message', 'Keep this draft');
    await ui.click('Save deadline'); expect(requests).toHaveLength(0);
    await ui.type('Question deadline', '2000-01-01T00:00'); await ui.click('Save deadline'); expect(requests).toHaveLength(0);
    const local = '2099-01-01T12:30', expiresAt = new Date(local).toISOString();
    await ui.type('Question deadline', local); await ui.click('Save deadline');
    expect(document.body.textContent).toContain('Worker unavailable');
    expect(document.body.textContent).toContain('Deadline: No expiry');
    expect((document.querySelector('[aria-label="Question deadline"]') as HTMLInputElement).value).toBe(local);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
    failure = false; await ui.click('Save deadline');
    expect(requests).toEqual(Array(2).fill({ action: 'question-deadline', roomId: 'room', goalId: 'goal', questionId: 'question', expiresAt }));
    expect(document.body.textContent).not.toContain('Deadline: No expiry');
    await ui.click('Remove deadline');
    expect(requests.at(-1)).toMatchObject({ action: 'question-deadline', expiresAt: null });
    expect(document.body.textContent).toContain('Deadline: No expiry');
  });
});
test('expired questions display their deadline and expose no cancel, reassign or deadline editor', async () => {
  await withDOM(async ui => {
    await ui.render(<GoalQuestions questions={[{ id: 'q', recipient: 'planner', text: 'Policy?', status: 'expired', closure: 'Question expired.', expiresAt: '2026-10-03T00:00:00.000Z' }]}
      members={[]} disabled={false} onChange={() => { throw new Error('No change expected'); }} onDeadline={() => { throw new Error('No change expected'); }} />);
    expect(document.body.textContent).toContain('expired'); expect(document.body.textContent).toContain('0 waiting');
    expect(document.querySelector('[aria-label="Question deadline"]')).toBeNull();
    expect(document.querySelectorAll('button')).toHaveLength(0);
  });
});


test('long goals stay usable without displaying a metrics report', async () => {
  await withDOM(async ui => {
    const data = recoverySnapshot();
    data.messages[0]!.status = 'waiting';
    Object.assign(data.messages[0]!.goalProgress!, { phase: 'ready', turns: 1201,
      usage: { reportedThroughTurn: 1200, inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    await ui.render(<ChatsView active api={{ request: async () => data }} />);
    await ui.click('Reply to Build login');
    expect(document.querySelector('[aria-label="Goal progress"]')).toBeNull();
    expect(document.querySelector('[aria-label="Room messages"]')?.textContent).not.toContain('Model tokens');
    expect(document.querySelector('[aria-label="Delivery target"]')?.textContent).not.toContain('Send to resume this goal');
  });
});


test('delegated work displays proposed changes directly in the room without task navigation', async () => {
  await withDOM(async ui => {
    const data = snapshot();
    data.messages.push({ id: 'work-result', kind: 'work_result', sender: 'peer', recipient: 'dev', roomId: 'room', threadId: 'goal', taskId: 'task',
      relatedTask: { agentId: 'peer', taskId: 'w_proposal' }, createdAt: '2026-10-04T00:00:00Z', status: 'delivered',
      text: JSON.stringify({ version: 1, status: 'submitted', snapshot: 'a'.repeat(64), summary: 'Greeting proposed',
        changes: [{ path: 'greet.ts', before: 'b'.repeat(64), sha256: 'c'.repeat(64), content: 'export const greeting = "hello";' }] }) });
    await ui.render(<ChatsView active api={{ request: async () => data }} />);
    await ui.click('Reply to Build login');
    expect(document.body.textContent).toContain('Greeting proposed');
    expect(document.body.textContent).toContain('Integration and independent verification are still required.');
    expect(document.body.textContent).toContain('greet.ts');
    expect(document.body.textContent).not.toContain('Delegated task');
    expect(document.body.textContent).not.toContain('Task details');
  });
});

test('unknown delegated task exposes execution inspection without claiming integration', async () => {
  await withDOM(async ui => {
    const recovered: string[] = [];
    await ui.render(<AgentTaskResults tasks={[{ id: 'work', prompt: 'Implement greeting', status: 'unknown', createdAt: '2026-10-04T00:00:00Z', output: '', error: null,
      inspection: { recoveryKind: 'delegation', recoveryRoomId: 'room', finishedAt: null, threadId: 'native', conversation: 'work', goal: null, messages: [], evidence: [], error: null } }]}
      requestedTaskId="work" loading={false} running onRecover={(id, room) => recovered.push(`${id}/${room}`)} />);
    expect(document.body.textContent).toContain('without replaying the task or applying project files');
    await ui.click('Inspect execution'); expect(recovered).toEqual(['work/room']);
  });
});

test('user questions appear in the conversation and answers use the shared composer with stable identity', async () => {
  await withDOM(async ui => {
    const data = snapshot();
    data.messages[0]!.dialogue = { userText: 'Build login', questions: [{ id: 'method', text: 'Which login method?', answer: null }], revisions: [] };
    data.messages.push({ id: 'question', roomId: 'room', threadId: 'goal', sender: 'dev', recipient: 'user', kind: 'question',
      taskId: 'task', text: 'Which login method?', createdAt: '2026-10-03T00:02:00Z', userQuestion: { rootId: 'goal', id: 'method', answered: false } });
    const requests: ChatsRequest[] = []; let fail = true;
    const api = { request: async (request: ChatsRequest) => {
      if (request.action === 'send') { requests.push(request); if (fail) throw new Error('Lost acknowledgement'); }
      return data;
    } };
    await ui.render(<ChatsView active api={api} />);
    expect(document.querySelector('[aria-label="Room messages"]')?.querySelectorAll('form')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-label="Room composer"]')).toHaveLength(1);
    expect(document.querySelector('[data-message-id="question"]')?.textContent).toContain('Needs your answer');
    await ui.click('Reply to Which login method?'); await ui.type('Message', 'Email only'); await ui.click('Send message');
    expect(document.body.textContent).toContain('Lost acknowledgement');
    fail = false; await ui.click('Send message');
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({ action: 'send', recipient: 'dev', replyTo: 'question', answerTo: 'goal', questionId: 'method', text: 'Email only', automatic: true, goal: false });
  });
});

test('retry wakes the saved recipient without sending a new prompt or showing an activity strip', async () => {
  await withDOM(async ui => {
    const data = snapshot(), requests: ChatsRequest[] = [];
    data.messages[0]!.worker = { phase: 'sleeping', error: null };
    const api = { request: async (input: ChatsRequest) => { requests.push(input); return data; } };
    const render = (active: boolean) => ui.render(<ChatsView active={active} api={api} />);
    await render(true); expect(document.querySelector('[aria-label="Current agent activity"]')).toBeNull();
    await render(false); data.messages[0]!.status = 'queued'; data.messages[0]!.error = 'Engine unavailable';
    data.messages[0]!.worker = { phase: 'error', error: 'Engine unavailable' }; await render(true);
    await ui.type('Message', 'Unsaved follow-up'); await ui.click('Retry worker');
    expect(requests.filter(r => r.action !== 'list')).toEqual([{ action: 'retry', roomId: 'room', messageId: 'goal' }]);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Unsaved follow-up');
  });
});

test('Chats portals its room list and preserves drafts, filtering and scroll across room and view changes', async () => {
  await withDOM(async ui => {
    const data = snapshot(); data.rooms.push({ ...data.rooms[0]!, id: 'second', name: 'Planning' });
    const api = { request: async () => data }, target = document.createElement('div'); document.body.append(target);
    let opened = 0;
    const render = (active: boolean) => ui.render(<ChatsView active={active} sidebarTarget={target} onOpenRoom={() => { opened++; }} api={api} />);
    await render(true);
    expect(target.querySelector('[aria-label="Worker rooms"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Worker"] [aria-label="Worker rooms"]')).toBeNull();
    await ui.type('Message', 'Keep login draft');
    const timeline = document.querySelector('[aria-label="Room messages"]') as HTMLElement;
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 200 });
    timeline.scrollTop = 120; timeline.dispatchEvent(new window.Event('scroll', { bubbles: true }));
    await ui.click('Planning'); await ui.type('Message', 'Keep planning draft');
    await ui.click('Login');
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep login draft');
    expect((document.querySelector('[aria-label="Room messages"]') as HTMLElement).scrollTop).toBe(120);
    await ui.type('Search rooms', 'Planning'); expect(target.querySelector('[aria-label="Login"]')).toBeNull();
    await render(false); await render(true);
    expect((target.querySelector('[aria-label="Search rooms"]') as HTMLInputElement).value).toBe('Planning');
    await ui.click('Planning'); expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep planning draft');
    expect(opened).toBe(3);
    await ui.click('Filter rooms');
    expect(document.activeElement).toBe(target.querySelector('[aria-label="Search rooms"]'));
    expect(target.querySelector('[aria-label="Login"]')).toBeNull();
    await ui.click('Clear room search');
    expect(target.querySelector('[aria-label="Login"]')).not.toBeNull();
    expect(document.activeElement).toBe(target.querySelector('[aria-label="Search rooms"]'));
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep planning draft');
  });
});
test('ordinary messages render safe markdown without completed or task-detail clutter', async () => {
  await withDOM(async ui => {
    const data = snapshot(); data.messages = [{ ...data.messages[1]!, threadId: null, status: 'completed', text: '**Important**\n\n- first\n- second\n\n[bad](javascript:alert(1))' }];
    await ui.render(<ChatsView active api={{ request: async () => data }} />);
    const timeline = document.querySelector('[aria-label="Room messages"]')!;
    expect(timeline.querySelector('strong')?.textContent).toBe('Development');
    expect([...timeline.querySelectorAll('strong')].some(node => node.textContent === 'Important')).toBe(true);
    expect(timeline.querySelectorAll('li')).toHaveLength(2);
    expect(timeline.querySelector('[href^="javascript:"]')).toBeNull();
    expect(timeline.textContent).not.toContain('completed'); expect(timeline.textContent).not.toContain('Task details');
    expect(document.body.textContent).not.toContain('Default:');
    expect(document.querySelector('[aria-description="Development"] [data-agent-avatar]')).not.toBeNull();
  });
});
test('Enter sends a follow-up while a goal runs, Shift+Enter and IME do not send, and repeated Enter saves once', async () => {
  await withDOM(async ui => {
    const data = snapshot(); data.messages[0]!.status = 'running';
    const requests: ChatsRequest[] = [];
    let finish!: () => void;
    const saved = new Promise<void>(resolve => { finish = resolve; });
    const api = { request: async (request: ChatsRequest) => { if (request.action === 'send') { requests.push(request); await saved; } return data; } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Reply to Build login'); await ui.type('Message', 'Email only');
    const input = document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
    const press = (options: KeyboardEventInit = {}) => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
    await act(async () => {
      expect(press({ shiftKey: true })).toBe(true);
      expect(press({ isComposing: true })).toBe(true);
      input.dispatchEvent(new window.Event('compositionstart', { bubbles: true })); expect(press()).toBe(true);
      input.dispatchEvent(new window.Event('compositionend', { bubbles: true }));
    });
    expect(requests).toHaveLength(0);
    await act(async () => { expect(press()).toBe(false); press(); });
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ action: 'send', threadId: 'goal', automatic: true, goal: false, text: 'Email only' });
    await ui.type('Message', 'Next requirement');
    await act(async () => { finish(); await saved; });
    expect(input.value).toBe('Next requirement');
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('empty Chats keeps room tools visible and enables them only after a room is available', async () => {
  await withDOM(async ui => {
    let data: ChatsSnapshot = { rooms: [], messages: [] };
    const api = { request: async () => data };
    await ui.render(<ChatsView active api={api} />);
    const conversation = document.querySelector('[aria-label="Room conversation"]')!;
    expect(conversation.textContent).toContain('Start working with your Homies');
    expect(conversation.textContent).toContain('Select a room in Worker, or create one');
    const rail = document.querySelector('[aria-label="Room tools"]')!;
    const buttons = [...conversation.querySelectorAll<HTMLButtonElement>('header [aria-label="Phone calls"]')];
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Phone calls']);
    expect(rail.querySelector('button')).toBeNull();
    expect(document.querySelector('[aria-label="Worker"] header [aria-label="Phone calls"]')).not.toBeNull();
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      await ui.click(button.getAttribute('aria-label')!);
      expect(document.querySelector('dialog')).toBeNull();
    }
    data = snapshot(); await ui.click('Refresh rooms');
    expect(document.querySelector('[aria-label="Room tools"]')).toBe(rail);
    expect(buttons.every(button => !button.disabled)).toBe(true);
    expect(conversation.textContent).not.toContain('Start working with your Homies');
    expect(document.querySelector('[aria-label="Room messages"]')?.hasAttribute('hidden')).toBe(false);
    data = { rooms: [], messages: [] }; await ui.click('Refresh rooms');
    expect(conversation.textContent).toContain('Start working with your Homies');
    expect(buttons.every(button => button.disabled)).toBe(true);
  });
});

test('offscreen Chats starts one initial read and never displays an empty-room notice while loading', async () => {
  await withDOM(async ui => {
    const pending = createDeferred<ChatsSnapshot>(); let reads = 0;
    const api = { request: async () => { reads++; return pending.promise; } };
    const render = (active: boolean) => ui.render(<ChatsView active={active} api={api} />);
    await render(false);
    expect(reads).toBe(1);
    expect(document.querySelector('[role="status"][aria-label="Loading rooms…"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Create a work room and invite');
    expect(document.body.textContent).not.toContain('Start working with your Homies');
    await render(true); await render(false); expect(reads).toBe(1);
    await act(async () => { pending.resolve(snapshot()); await pending.promise; });
    await render(true);
    expect(reads).toBe(1); expect(document.querySelector('[aria-label="Login"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Loading rooms…"]')).toBeNull();
  });
});

test('first-load failure shows the error and retry, not a create-room invitation', async () => {
  await withDOM(async ui => {
    let fail = true;
    const api = { request: async () => { if (fail) throw new Error('Room service unavailable'); return { rooms: [], messages: [] }; } };
    await ui.render(<ChatsView active api={api} />);
    expect(document.body.textContent).toContain('Room service unavailable');
    expect(document.querySelector('[aria-label="Room conversation"]')?.textContent).toContain('Could not load Worker');
    expect(document.body.textContent).not.toContain('Start working with your Homies');
    expect(document.body.textContent).not.toContain('Create a work room and invite');
    expect((document.querySelector('[aria-label="Refresh rooms"]') as HTMLButtonElement).disabled).toBe(false);
    fail = false; await ui.click('Refresh rooms');
    expect(document.body.textContent).not.toContain('Room service unavailable');
    expect(document.body.textContent).toContain('Create a work room and invite');
  });
});

test('refresh keeps room selection, draft and list scroll visible through failure and retry', async () => {
  await withDOM(async ui => {
    const background = createDeferred<ChatsSnapshot>(); let reads = 0;
    const data = snapshot(); data.rooms.push({ ...data.rooms[0]!, id: 'second', name: 'Planning' });
    const api = { request: async () => { reads++; return reads === 2 ? background.promise : data; } };
    await ui.render(<ChatsView active api={api} />);
    await ui.click('Planning'); await ui.type('Message', 'Keep this draft');
    const list = document.querySelector('[role="region"][aria-label="Rooms"]') as HTMLElement;
    list.scrollTop = 75;
    await ui.click('Refresh rooms');
    expect(document.querySelector('[aria-label="Planning"][aria-current="page"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Loading rooms…"]')).toBeNull();
    expect(document.querySelector('[role="region"][aria-label="Rooms"]')).toBe(list);
    await act(async () => { background.reject(new Error('Refresh failed')); await background.promise.catch(() => {}); });
    expect(document.body.textContent).toContain('Refresh failed'); expect(list.scrollTop).toBe(75);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
    await ui.click('Refresh rooms'); expect(document.body.textContent).not.toContain('Refresh failed');
    expect(document.querySelector('[aria-label="Planning"][aria-current="page"]')).not.toBeNull();
    expect(list.scrollTop).toBe(75);
  });
});

test('room interleaves agent messages and execution cards by recorded time and updates failed commands in place', async () => {
  await withDOM(async ui => {
    const data = snapshot(); data.cursor = { epoch: 'timeline', sequence: 0 };
    data.messages[0]!.status = 'running'; data.messages[1]!.text = 'I will fix the test';
    data.messages.push({ id: 'command', roomId: 'room', threadId: 'goal', sender: 'dev', recipient: null, kind: 'message', text: '', taskId: 'task', createdAt: '2026-10-03T00:00:30Z',
      activity: { id: 'native-command', turnId: 'turn', kind: 'command', title: 'bun test login', text: '', status: 'running', createdAt: '2026-10-03T00:00:30Z', final: false, truncated: false } });
    let receive!: (update: import('../shared/agent-chats').ChatsUpdate) => void;
    const api = { request: async () => data, onDidChange: (listener: typeof receive) => { receive = listener; return () => {}; } };
    await ui.render(<ChatsView active api={api} />);
    const ids = () => [...document.querySelectorAll('[data-message-id]')].map(node => node.getAttribute('data-message-id'));
    expect(ids()).toEqual(['goal', 'command', 'reply']);
    const command = document.querySelector('[data-message-id="command"]')!;
    expect(command.textContent).toContain('Running');
    await ui.type('Message', 'Keep my draft');
    const timeline = document.querySelector('[aria-label="Room messages"]') as HTMLElement;
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 200 });
    timeline.scrollTop = 100; timeline.dispatchEvent(new window.Event('scroll', { bubbles: true }));
    const changed = { ...data.messages[2]!, activity: { ...data.messages[2]!.activity!, status: 'failed' as const, text: 'Invalid password accepted' } };
    await act(async () => receive({ cursor: { epoch: 'timeline', sequence: 1 }, rooms: [], messages: [changed], removedRoomIds: [], removedMessageIds: [] }));
    expect(document.querySelector('[data-message-id="command"]')).toBe(command);
    expect(command.textContent).toContain('Failed'); expect(command.textContent).toContain('Invalid password accepted');
    expect(ids()).toEqual(['goal', 'command', 'reply']); expect(timeline.scrollTop).toBe(100);
    expect((document.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe('Keep my draft');
    expect(document.querySelector('[data-message-id="reply"]')?.textContent).not.toContain('waiting');
  });
});

test('answered questions retain their connection with simultaneous workers and no activity strip', async () => {
  await withDOM(async ui => {
    const data = snapshot(); data.messages[0]!.status = 'running';
    data.rooms[0]!.members.push({ id: 'planner', accountId: 'p', name: 'Planning' });
    data.messages.push({ id: 'question', roomId: 'room', threadId: 'goal', sender: 'dev', recipient: 'planner', kind: 'question', text: 'Password reset too?', taskId: 'task', createdAt: '2026-10-03T00:02:00Z', questionId: 'question', status: 'delivered',
      relatedTask: { agentId: 'planner', taskId: 'planning' }, executionStatus: 'running' });
    data.messages.push({ id: 'answer', roomId: 'room', threadId: 'goal', sender: 'planner', recipient: 'dev', kind: 'reply', text: 'Yes, include it.', taskId: 'task', createdAt: '2026-10-03T00:03:00Z', questionId: 'question', status: 'delivered' });
    await ui.render(<ChatsView active api={{ request: async () => data }} />);
    expect(document.querySelector('[data-message-id="question"]')?.textContent).toContain('Answered');
    expect(document.querySelector('[data-message-id="answer"] blockquote')?.textContent).toContain('Password reset too?');
    expect(document.querySelector('[aria-label="Current agent activity"]')).toBeNull();
    expect(document.querySelector('[aria-label="Room messages"]')?.textContent).not.toContain('delivered');
    expect(document.body.textContent).not.toContain('Task details');
  });
});


test('legacy questions recover exact reply links without an unavailable-work activity strip', async () => {
  await withDOM(async ui => {
    const data = snapshot(), questionId = 'a'.repeat(64);
    data.messages[0]!.status = 'blocked';
    data.messages[0]!.error = 'Independent verification is missing';
    data.messages[0]!.worker = { phase: 'sleeping', error: null };
    data.messages[0]!.goalProgress = { phase: 'unavailable', progress: '', reason: '', nextAction: '', turns: null, resumeBlocked: 'Refresh the worker to confirm its task state.' };
    const question = { id: `peer_${questionId}`, roomId: 'room', threadId: 'goal', sender: 'dev', recipient: 'planner', kind: 'question' as const, text: 'Include password reset?', taskId: 'task', createdAt: '2026-10-03T00:02:00Z', status: 'delivered' };
    data.messages.push(question, { ...question, id: `peer_${createHash('sha256').update(`reply/${questionId}`).digest('hex')}`, sender: 'planner', recipient: 'dev', kind: 'reply', text: 'Yes, include password reset.' });
    await ui.render(<ChatsView active api={{ request: async () => data }} />);
    for (let attempt = 0; attempt < 30 && !document.querySelector(`[data-message-id="${question.id}"]`)?.textContent?.includes('Answered'); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    expect(document.querySelector(`[data-message-id="${question.id}"]`)?.textContent).toContain('Answered');
    expect(document.querySelector('[aria-label="Room messages"]')?.textContent).not.toContain('Awaiting reply');
    expect(document.querySelector('[aria-label="Work records"]')).toBeNull();
    expect(document.querySelector('[aria-label="Current agent activity"]')).toBeNull();
  });
});


test('Homies slides inside Worker before its fixed tools rail and closes through the trigger or Escape', async () => {
  const api = { request: async () => snapshot() };
  function Harness() {
    const [open, setOpen] = useState(false);
    const [target, setTarget] = useState<HTMLDivElement | null>(null);
    return <>
      <ChatsView active api={api} homiesOpen={open} onHomiesTarget={setTarget}
        onManageHomies={() => setOpen(value => !value)} onCloseHomies={() => setOpen(false)} />
      {target && createPortal(<button onKeyDown={event => {
        if (event.key === 'Escape' && event.shiftKey) event.preventDefault();
      }}>Sidebar content</button>, target)}
    </>;
  }
  await withDOM(async ui => {
    await ui.render(<Harness />);
    await ui.type('Message', 'Keep sliding draft');
    const timeline = document.querySelector('[aria-label="Room messages"]');
    const rail = document.querySelector('[aria-label="Room tools"]')!;
    const panel = document.querySelector<HTMLElement>('[aria-label="Homies sidebar"]')!;
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Manage Homies"]')!;
    expect(panel.parentElement?.nextElementSibling).toBe(rail);
    expect(panel.closest('[aria-label="Worker"]')).not.toBeNull();
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    await ui.click('Manage Homies');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(false);
    const content = document.getElementById(trigger.getAttribute('aria-controls')!)!.querySelector('button')!;
    await act(async () => content.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Escape', shiftKey: true, bubbles: true, cancelable: true,
    })));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      content.focus();
      content.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.contains(content)).toBe(true);
    await ui.click('Manage Homies'); await ui.click('Manage Homies');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[aria-label="Room tools"]')).toBe(rail);
    expect(document.querySelector('[aria-label="Room messages"]')).toBe(timeline);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe('Keep sliding draft');
  });
});
