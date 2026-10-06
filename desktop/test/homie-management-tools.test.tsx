import { expect, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import { SpecialistAgentForm } from '../frontend/src/features/agents/SpecialistAgentForm';
import { HomieParticipation } from '../frontend/src/features/agents/HomieParticipation';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import type { SaveSpecialistAgent } from '../shared/agent-registry';
import type { AgentPackage } from '../shared/agent-package';
import type { AgentRoom, ChatsRequest } from '../shared/agent-chats';
import { specialistAgent } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

const field = (label: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const agent = { ...specialistAgent(), model: null, reasoningEffort: null, serviceTier: null,
  assignments: [{ workspaceRoot: '/project', instructions: 'Project only' }] };
function fixture(options: { failSave?: boolean; cancelExport?: boolean } = {}) {
  const saves: SaveSpecialistAgent[] = [], exports: AgentPackage[] = [];
  let failed = false;
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }), models: async () => [],
    onDidChange: () => () => {}, packages: async () => [],
    save: async input => {
      if (options.failSave && !failed) { failed = true; throw new Error('Disk unavailable'); }
      saves.push(input);
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [{ ...agent, ...input.profile, revision: 2 }] } };
    }, exportPackage: async pack => { exports.push(pack); return !options.cancelExport; },
    installPackage: async () => { throw new Error('Saving a Homie must not separately install a pack'); },
  });
  function Editor({ creating = false }: { creating?: boolean }) {
    const state = useSyncExternalStore(model.subscribe, model.snapshot);
    return <SpecialistAgentForm agent={creating ? undefined : state.data?.agents[0]} model={model} state={state} />;
  }
  return { model, saves, exports, Editor };
}

test('the unified editor saves all sections directly and exports only portable current settings', async () => {
  const { model, saves, exports, Editor } = fixture();
  await model.refresh();
  try {
    await withDOM(async ui => {
      await ui.render(<Editor />);
      expect(document.querySelector('[aria-label="Homie sections"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain('Apply to Homie');
      expect(document.body.textContent).not.toContain('Save pack');
      await ui.type('Agent name', 'Unified Homie');
      await ui.type('Homie description', 'Reusable reviewer');
      await ui.click('Instructions');
      expect(document.querySelector<HTMLElement>('[aria-label="Basic information settings"]')!.hidden).toBe(true);
      expect(document.querySelector<HTMLElement>('[aria-label="Instruction settings"]')!.hidden).toBe(false);
      await ui.type('Agent instructions', 'Review current changes.');
      await ui.type('Project instructions', 'Keep local only.');
      await ui.click('Skills'); await ui.type('Skill name', 'Check'); await ui.type('Skill description', 'Check changes.');
      await ui.type('Skill instructions', 'Inspect the diff.'); await ui.click('Add skill');
      await ui.click('Tools'); await ui.click('Enable codegraph');
      await ui.click('Allow agent commands');
      await ui.click('Files and environment'); await ui.click('Add python3'); await ui.click('Add jq');
      await ui.click('Basic information'); expect(field('Agent name').value).toBe('Unified Homie');
      await ui.click('Save agent');
      expect(saves).toHaveLength(1);
      expect(saves[0]!.profile.package!.resources!.programs).toEqual(['python3', 'jq']);
      expect(saves[0]!.profile.package!.resources!.files[0]!.content).toContain('Inspect the diff.');
      expect(saves[0]!.assignment.instructions).toBe('Keep local only.');
      await ui.click('Instructions'); await ui.type('Agent instructions', 'Latest unsaved instructions.');
      await ui.click('Homie actions'); await ui.click('Export…');
      expect(exports).toHaveLength(1);
      expect(exports[0]!.name).toBe('Unified Homie');
      expect(exports[0]!.instructions).toBe('Latest unsaved instructions.');
      expect(exports[0]!.enabledTools).not.toContain('codegraph');
      expect(exports[0]!.requestedPermissions).toEqual(saves[0]!.assignment.permissions!);
      expect(exports[0]).not.toHaveProperty('accountId');
      expect(exports[0]).not.toHaveProperty('assignments');
      expect(JSON.stringify(exports[0])).not.toContain('Keep local only.');
      expect(saves).toHaveLength(1);
    });
  } finally { model.dispose(); }
});

test('new Homies use the same section layout without entering a pack editor', async () => {
  const { model, saves, Editor } = fixture(); await model.refresh();
  try {
    await withDOM(async ui => {
      await ui.render(<Editor creating />);
      await ui.type('Agent name', 'New Homie');
      await ui.click('Skills'); await ui.type('Skill name', 'draft');
      await ui.click('Instructions'); await ui.type('Agent instructions', 'New instructions.');
      await ui.click('Skills'); expect(field('Skill name').value).toBe('draft');
      await ui.click('Create agent');
      expect(saves[0]!.id).toBeNull();
      expect(saves[0]!.profile.instructions).toBe('New instructions.');
      expect(saves[0]!.profile.package!.name).toBe('New Homie');
    });
  } finally { model.dispose(); }
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


test('failed saves retain all section drafts and cancelled exports do not show success', async () => {
  const { model, saves, Editor } = fixture({ failSave: true, cancelExport: true }); await model.refresh();
  try {
    await withDOM(async ui => {
      await ui.render(<Editor />); await ui.type('Homie description', 'Keep my description.');
      await ui.click('Save agent');
      expect(document.querySelector('[role="alert"]')?.textContent).toBe('Disk unavailable');
      expect(field('Homie description').value).toBe('Keep my description.');
      await ui.click('Homie actions'); await ui.click('Export…'); expect(document.body.textContent).not.toContain('Homie pack exported.');
      await ui.click('Save agent'); expect(saves).toHaveLength(1);
      await ui.type('Homie pack version', 'bad'); await ui.click('Save agent');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('version');
      expect(saves).toHaveLength(1);
    });
  } finally { model.dispose(); }
});

test('file selection preserves existing assets on duplicate import in the unified form', async () => {
  const { model, exports, Editor } = fixture(); await model.refresh();
  try {
    await withDOM(async ui => {
      await ui.render(<Editor />); await ui.click('Files and environment');
      const input = document.querySelector<HTMLInputElement>('input[type="file"][aria-label="Add files"]')!;
      const choose = async (content: string) => {
        Object.defineProperty(input, 'files', { configurable: true, value: [new File([content], 'check.ts', { type: 'text/plain' })] });
        await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
      };
      await choose('console.log("first");'); await ui.click('scripts/check.ts');
      expect(field('Homie pack file content').value).toContain('first');
      await choose('replacement');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Duplicate');
      await ui.click('Homie actions'); await ui.click('Export…');
      expect(exports[0]!.resources!.files).toEqual([{ path: 'scripts/check.ts', content: 'console.log("first");' }]);
    });
  } finally { model.dispose(); }
});
