import { expect, test } from 'bun:test';
import type { AgentDetails, AgentTask } from '../shared/agent-management';
import type { TaskInspection } from '../shared/agent-task-inspection';
import { runtimeStatusPresentation } from '../frontend/src/features/agents/runtimeStatusPresentation';
import { SpecialistRuntimePanel } from '../frontend/src/features/agents/SpecialistRuntimePanel';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import { specialistAgent } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';
import { withRuntimePolling } from './agent-runtime-test-polling';

const inspection: TaskInspection = { finishedAt: null, threadId: 'thread', conversation: 'task',
  goal: null, messages: [], evidence: [], error: null };
const permission = { id: 'permission', reason: 'Read the requested file.', fileWrite: false, commandExecution: true };
const task: AgentTask = { id: 'task', prompt: '', status: 'waiting', createdAt: '', output: '', error: null, inspection };
const ready: AgentDetails = { agent: { id: 'worker', name: 'Atlas', state: 'running', image: 'fixture' },
  ready: true, busy: false, authenticated: true, threadId: null, error: null, logs: '', tasks: [] };
const waiting = (tasks: AgentTask[]) => runtimeStatusPresentation({ label: 'Waiting for reply',
  details: { ...ready, tasks }, error: null, notice: null });
const permissionTask = (status: 'pending' | 'allowed' | 'denied'): AgentTask => ({ ...task,
  inspection: { ...inspection, permissionRequest: { ...permission, status } } });

test('waiting status distinguishes permission decisions, unanswered questions and other pauses', () => {
  const approval = waiting([permissionTask('pending')]);
  expect(approval.label).toBe('Waiting for approval');
  expect(approval.reason).toBe(permission.reason);
  expect(approval.next).toContain('Deny');
  const allowed = waiting([permissionTask('allowed')]);
  expect(allowed.label).toBe('Approved · awaiting resume');
  expect(allowed.next).toContain('does not automatically resume');
  expect(waiting([permissionTask('denied')]).label).toBe('Permission denied · paused');
  const question = { ...permissionTask('allowed'), inspection: { ...permissionTask('allowed').inspection!,
    dialogue: { userText: 'Inspect', questions: [{ id: 'question', text: 'Which device?', answer: null }], revisions: [] } } };
  expect(waiting([question])).toMatchObject({ label: 'Waiting for reply', reason: 'Which device?' });
  expect(waiting([task]).label).toBe('Task paused');
  expect(waiting([permissionTask('pending'), permissionTask('allowed')]).label).toBe('Waiting for approval');
});

test('settings and execution errors retain their reasons and actionable guidance', () => {
  const input = { label: 'Error' as const, details: ready, notice: null };
  const settings = runtimeStatusPresentation({ ...input, error: 'Settings changed. Start the agent to apply them.' });
  expect(settings.label).toBe('Settings need applying');
  expect(settings.next).toContain('Apply changes');
  const apparmor = runtimeStatusPresentation({ ...input, error: 'Worker start failed: AppArmor profile missing.' });
  expect(apparmor.label).toBe('Error');
  expect(apparmor.error).toContain('AppArmor');
  expect(apparmor.next).toContain('Prepare Homies');
  expect(runtimeStatusPresentation({ ...input, label: 'Ready', error: null }).label).toBe('Ready');
  expect(runtimeStatusPresentation({ ...input, label: 'Ready', error: null,
    details: { ...ready, tasks: [{ ...task, status: 'unknown' }] } }).label).toBe('Result unknown');
});

test('compact Status updates after approval, running, completion and error without duplicate text', async () => {
  const agent = specialistAgent();
  let details = { ...ready, tasks: [permissionTask('pending')] };
  const labels: string[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }),
    models: async () => [], save: async () => { throw Error('unused'); }, onDidChange: () => () => {},
    runtime: async () => ({ details }) });
  try {
    await withRuntimePolling(async poll => {
      await withDOM(async ui => {
        await ui.render(<SpecialistRuntimePanel compact assigned agent={agent} model={model}
          engines={[{ id: 'docker:test', name: 'Test', supported: true, reason: null }]} engineId="docker:test"
          onStatusChange={label => { if (label) labels.push(label); }} />);
        const section = () => document.querySelector('section[aria-label="Status"]')!;
        const label = () => section().querySelector('[aria-label="Worker status"]')?.textContent;
        expect(label()).toBe('Waiting for approval');
        details = { ...ready, tasks: [permissionTask('allowed')] };
        await poll();
        expect(label()).toBe('Approved · awaiting resume');
        expect(section().textContent).toContain('Next step');
        expect(section().textContent).not.toContain('Waiting for reply');
        details = { ...ready, busy: true, tasks: [{ ...permissionTask('allowed'), status: 'running' }] };
        await poll(); expect(label()).toBe('Working');
        details = { ...ready, tasks: [{ ...permissionTask('allowed'), status: 'completed' }] };
        await poll(); expect(label()).toBe('Ready');
        const error = 'Settings changed. Start the agent to apply them.';
        details = { ...ready, tasks: [], error };
        await poll(); expect(label()).toBe('Settings need applying');
        expect(section().querySelector('[role="alert"]')?.textContent).toBe(error);
        expect(document.querySelectorAll('[aria-label="Worker status"]')).toHaveLength(1);
        expect(labels.at(-1)).toBe('Settings need applying');
      });
    });
  } finally { model.dispose(); }
});
