import { expect, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import type { HomieEditorDraft } from '../frontend/src/features/agents/homieEditorDraft';
import { SpecialistAgentForm } from '../frontend/src/features/agents/SpecialistAgentForm';
import { HomieParticipation } from '../frontend/src/features/agents/HomieParticipation';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import type { SaveSpecialistAgent } from '../shared/agent-registry';
import type { AgentRoom, ChatsRequest } from '../shared/agent-chats';
import type { HomieSourceState } from '../shared/homie-source';
import { registryDeferred, specialistAgent } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

const agent = { ...specialistAgent(), assignments: [{ workspaceRoot: '/project', instructions: '' }] };
function fixture(failSave = false) {
  let currentAgent = agent;
  const saves: SaveSpecialistAgent[] = [], actions: string[] = [];
  let failed = false;
  const source: HomieSourceState = { directory: '/homie', phase: 'pending', message: 'Changes pending.', hash: 'a'.repeat(64) };
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [currentAgent] }), models: async () => [],
    source: async input => { actions.push(input.action); return { ...source }; },
    runtime: async input => { actions.push(input.action); throw new Error('Wait for active work.'); },
    onDidChange: () => () => {}, save: async input => {
      if (failSave && !failed) { failed = true; throw new Error('Disk unavailable'); }
      saves.push(input); return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [{ ...agent, ...input.profile, revision: 2 }] } };
    } });
  function Editor({ creating = false, draft, onDraft }: { creating?: boolean; draft?: HomieEditorDraft; onDraft?(value: HomieEditorDraft): void }) {
    const state = useSyncExternalStore(model.subscribe, model.snapshot);
    return <SpecialistAgentForm draft={draft} onDraft={onDraft} agent={creating ? undefined : state.data?.agents[0]} model={model} state={state} engineId="docker:test" />;
  }
  return { model, saves, actions, source, Editor, update: async (next: typeof agent) => { currentAgent = next; await model.refresh(); } };
}

test('an untouched editor refreshes after repository application and saves against the latest revision', async () => {
  const f = fixture(); await f.model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<f.Editor />);
    await act(async () => f.update({ ...agent, revision: 2, instructions: 'New file instructions',
      assignments: [{ workspaceRoot: '/project', instructions: '' }] }));
    expect(document.body.textContent).not.toContain('Your local draft is preserved');
    expect(document.querySelector('[aria-label="Project instructions"]')).toBeNull();
    await ui.click('Save local settings'); expect(f.saves[0]?.revision).toBe(2);
    expect(f.saves[0]?.profile.instructions).toBe('New file instructions');
  }); } finally { f.model.dispose(); }
});

test('unsaved local settings survive external updates and reopening, then refresh after reverting the edit', async () => {
  const f = fixture(); await f.model.refresh();
  let draft: HomieEditorDraft | undefined;
  const remember = (value: HomieEditorDraft) => { draft = value; };
  try { await withDOM(async ui => {
    await ui.render(<f.Editor onDraft={remember} />);
    await ui.click('Allow agent file changes');
    await act(async () => f.update({ ...agent, revision: 2, instructions: 'Changed in file' }));
    expect(document.body.textContent).toContain('Your local draft is preserved');
    await ui.render(null); await ui.render(<f.Editor draft={draft} onDraft={remember} />);
    expect(document.querySelector('[aria-label="Allow agent file changes"]')?.getAttribute('aria-checked')).toBe('true');
    await ui.click('Save local settings'); expect(f.saves).toHaveLength(0);
    await ui.click('Allow agent file changes');
    expect(document.body.textContent).not.toContain('Your local draft is preserved');
    await ui.click('Save local settings'); expect(f.saves[0]?.revision).toBe(2);
  }); } finally { f.model.dispose(); }
});

test('existing Homies expose repository actions and retain local permissions without portable editors', async () => {
  const f = fixture(); await f.model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<f.Editor />);
    expect(document.querySelector('[aria-label="Agent instructions"]')).toBeNull();
    expect(document.querySelector('[aria-label="Agent name"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Project instruction overrides');
    expect(document.body.textContent).not.toContain('Link MD files');
    await ui.click('Allow agent commands'); await ui.click('Allow agent file changes');
    await ui.click('Save local settings');
    expect(f.saves[0]?.assignment.permissions?.commandExecution).toBe(true);
    expect(f.saves[0]?.assignment.instructions).toBe('');
    expect(f.saves[0]?.assignment.instructionFiles).toBeUndefined();
    expect(f.saves[0]?.profile.instructions).toBe(agent.instructions);
    expect(f.actions).not.toContain('start');
  }); } finally { f.model.dispose(); }
});

test('applying files reports busy workers and never claims successful application', async () => {
  const f = fixture(); await f.model.refresh();
  const pending = registryDeferred<Awaited<ReturnType<AgentRegistryModel['runtime']>>>();
  f.model.runtime = async input => { f.actions.push(input.action); return pending.promise; };
  try { await withDOM(async ui => {
    await ui.render(<f.Editor />);
    const actions = document.querySelector('[aria-label="Homie actions"]')!;
    const apply = [...actions.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Apply changes')!;
    await act(async () => apply.click());
    expect([...actions.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
    await ui.click('Save local settings'); await act(async () => apply.click());
    expect(f.actions.filter(action => action === 'start')).toHaveLength(1);
    expect(f.saves).toHaveLength(0);
    await act(async () => pending.reject(new Error('Wait for active work.')));
    expect(f.actions).toContain('start'); expect(document.body.textContent).toContain('Wait for active work.');
    expect(apply.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('configuration is applied');
    expect(f.saves).toHaveLength(0);
  }); } finally { f.model.dispose(); }
});

test('conflicts require selecting repository files before applying and invalid files block application', async () => {
  const f = fixture(); f.source.phase = 'conflict'; f.source.message = 'Versions differ.'; await f.model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<f.Editor />);
    expect(document.querySelector('[aria-label="Repository configuration"] [role="alert"]')?.textContent).toBe('Versions differ.');
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Apply changes')?.disabled).toBe(true);
    f.source.phase = 'pending'; await ui.click('Use repository files');
    expect(f.actions).toContain('use-files'); expect(f.actions).not.toContain('start');
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Apply changes')?.disabled).toBe(false);
    await ui.render(null); f.source.phase = 'invalid'; f.source.message = 'agent.json is invalid.';
    await ui.render(<f.Editor />);
    expect(document.querySelector('[aria-label="Repository configuration"] [role="alert"]')?.textContent).toBe('agent.json is invalid.');
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Apply changes')?.disabled).toBe(true);
    await ui.render(null); f.source.phase = 'missing'; f.source.message = 'Repository is missing.';
    await ui.render(<f.Editor />);
    expect(document.querySelector('[aria-label="Repository configuration"] [role="alert"]')?.textContent).toBe('Repository is missing.');
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Apply changes')?.disabled).toBe(true);
  }); } finally { f.model.dispose(); }
});

test('a failed local save keeps the user draft and can be retried', async () => {
  const f = fixture(true); await f.model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<f.Editor />); await ui.click('Allow agent file changes'); await ui.click('Save local settings');
    expect(document.body.textContent).toContain('Disk unavailable');
    expect(document.querySelector('[aria-label="Allow agent file changes"]')?.getAttribute('aria-checked')).toBe('true');
    await ui.click('Save local settings'); expect(f.saves).toHaveLength(1);
  }); } finally { f.model.dispose(); }
});
test('room participation rechecks current membership and never sends work or replaces the default agent', async () => {
  const agent = { ...specialistAgent(), accountId: 'default', assignments: [{ workspaceRoot: '/project', instructions: '' }] };
  let room: AgentRoom = { id: 'room', name: 'Current work', workspace: '/project', engineId: 'docker:test', defaultAgentId: 'owner', createdAt: '2026-10-06',
    members: [{ id: 'owner', accountId: 'default', name: 'Owner' }] };
  const calls: ChatsRequest[] = [];
  await withDOM(async ui => {
    await ui.render(<HomieParticipation agent={agent} workspaceRoot="/project" roomId="room" api={{ request: async request => {
      calls.push(request);
      if (request.action === 'invite') room = { ...room, members: [...room.members, { id: agent.id, name: agent.name, accountId: agent.accountId }] };
      return { rooms: [room], messages: [] };
    } }} />);
    room = { ...room, members: [...room.members, { id: 'peer', accountId: 'default', name: 'Peer' }] };
    await ui.click('Join work room');
    expect(calls).toEqual([{ action: 'list' }, { action: 'list' }, { action: 'invite', roomId: 'room', members: ['owner', 'peer', agent.id], defaultAgentId: 'owner' }]);
    expect(document.body.textContent).toContain('Participating');
    expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Participating')?.disabled).toBe(true);
  });
});


test('display name edits preserve the repository name and survive saving and reopening', async () => {
  const f = fixture(); await f.model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<f.Editor />);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Homie display name"]')?.value).toBe(agent.name);
    await ui.type('Homie display name', 'Dwight');
    await ui.click('Save local settings');
    expect(f.saves[0]?.profile.displayName).toBe('Dwight');
    expect(f.saves[0]?.profile.name).toBe(agent.name);
    expect(f.saves[0]?.id).toBe(agent.id);
    await ui.render(null); await ui.render(<f.Editor />);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Homie display name"]')?.value).toBe('Dwight');
    expect(document.querySelector('h2')?.textContent).toBe('Dwight');
    await ui.type('Homie display name', '   '); await ui.click('Save local settings');
    expect(f.saves).toHaveLength(1);
  }); } finally { f.model.dispose(); }
});

test('unsaved display names remain drafts when a repository update arrives', async () => {
  const f = fixture(); await f.model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<f.Editor />); await ui.type('Homie display name', 'Local draft');
    await act(async () => f.update({ ...agent, revision: 2, instructions: 'Changed in files' }));
    expect(document.body.textContent).toContain('Your local draft is preserved');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Homie display name"]')?.value).toBe('Local draft');
    await ui.click('Save local settings'); expect(f.saves).toHaveLength(0);
  }); } finally { f.model.dispose(); }
});
