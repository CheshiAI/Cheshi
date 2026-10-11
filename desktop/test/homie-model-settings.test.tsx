import { expect, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import { SpecialistAgentForm } from '../frontend/src/features/agents/SpecialistAgentForm';
import { AgentRegistryModel } from '../frontend/src/features/agents/agentRegistryModel';
import type { HomieEditorDraft } from '../frontend/src/features/agents/homieEditorDraft';
import type { CodexAccountsApi } from '../shared/codex-accounts';
import type { SaveSpecialistAgent } from '../shared/agent-registry';
import { specialistAgent, specialistModels } from './agent-registry-fixtures';
import { withDOM } from './agent-chats-test-dom';

const accounts: Pick<CodexAccountsApi, 'list' | 'onDidChange'> = {
  list: async () => ({ activeId: 'default', profiles: ['default', 'limited'].map(id => ({ id, label: id, email: null,
    login: { state: 'signed_in' as const, error: null },
    usage: { state: 'ready' as const, authenticated: true, plan: null, rateLimits: [], error: null } })) }),
  onDidChange: () => () => {},
};
function fixture() {
  let agent = { ...specialistAgent(), accountId: 'default' };
  const loads: string[] = [];
  const saves: SaveSpecialistAgent[] = [];
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [agent] }),
    models: async id => { loads.push(id); return id === 'limited' ? [specialistModels()[1]!] : specialistModels(); },
    onDidChange: () => () => {}, save: async input => {
      saves.push(input);
      agent = { ...agent, ...input.profile, accountId: input.profile.accountId!, revision: agent.revision + 1 };
      return { agentId: agent.id, snapshot: { workspaceRoot: '/project', agents: [agent] } };
    } });
  function Editor({ creating = false, draft, onDraft }: {
    creating?: boolean; draft?: HomieEditorDraft; onDraft?(value: HomieEditorDraft): void;
  }) {
    const state = useSyncExternalStore(model.subscribe, model.snapshot);
    return <SpecialistAgentForm inline fill agent={creating ? undefined : state.data?.agents[0]} model={model} state={state}
      accountsApi={accounts} draft={draft} onDraft={onDraft} />;
  }
  return { model, saves, loads, Editor, externalUpdate: async () => {
    agent = { ...agent, revision: agent.revision + 1, instructions: 'Updated in files.' }; await model.refresh();
  } };
}
const control = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;

for (const creating of [true, false]) test(`${creating ? 'creation' : 'editing'} saves model, effort and speed and restores persisted choices`, async () => {
  const f = fixture(); await f.model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<f.Editor creating={creating} />);
    if (creating) {
      expect(control('Agent model').disabled).toBe(true);
      await ui.type('Agent name', 'New Homie');
      await ui.click('Agent account'); await ui.click('default');
    }
    expect(control('Agent model').textContent).toContain('Fixture model');
    expect(control('Agent reasoning effort').textContent).toContain('Medium');
    expect(control('Agent service tier').textContent).toContain('Standard');
    expect(document.body.textContent).not.toContain('Runtime default');
    await ui.click('Agent model'); await ui.click('Fixture model');
    await ui.click('Agent reasoning effort'); await ui.click('High');
    await ui.click('Agent service tier'); await ui.click('Fast');
    await ui.click(creating ? 'Create agent' : 'Save local settings');
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]?.profile).toMatchObject({ model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' });
    if (creating) expect(f.saves[0]?.profile.package?.model).toEqual({ model: 'model-fixture', reasoningEffort: 'high', serviceTier: 'priority' });
    await ui.render(null); await ui.render(<f.Editor />);
    expect(control('Agent model').textContent).toContain('Fixture model');
    expect(control('Agent reasoning effort').textContent).toContain('High');
    expect(control('Agent service tier').textContent).toContain('Fast');
    expect(f.loads).toEqual(['default']);
  }); } finally { f.model.dispose(); }
});

test('account changes validate retained choices and model changes reset unsupported effort and speed', async () => {
  const f = fixture(); await f.model.refresh();
  try { await withDOM(async ui => {
    await ui.render(<f.Editor />);
    await ui.click('Agent model'); await ui.click('Fixture model');
    await ui.click('Agent reasoning effort'); await ui.click('High');
    await ui.click('Agent service tier'); await ui.click('Fast');
    await ui.click('Agent account'); await ui.click('limited');
    expect(submit().disabled).toBe(true);
    expect(control('Agent model').textContent).toContain('(unavailable)');
    await ui.click('Agent model'); await ui.click('Small model');
    expect(control('Agent reasoning effort').textContent).toContain('Low');
    expect(control('Agent service tier').textContent).toContain('Standard');
    await ui.click('Save local settings');
    expect(f.saves[0]?.profile).toMatchObject({ accountId: 'limited', model: 'small-fixture', reasoningEffort: 'low', serviceTier: null });
    await ui.click('Agent account'); await ui.click('Configure later');
    expect(control('Agent model').textContent).toContain('Choose a model');
    expect(submit().disabled).toBe(false);
    await ui.click('Save local settings');
    expect(f.saves[1]?.profile).toMatchObject({ accountId: null, model: null, reasoningEffort: null, serviceTier: null });
  }); } finally { f.model.dispose(); }
});

test('unsaved model choices survive repository updates and reopening without overwriting a newer revision', async () => {
  const f = fixture(); await f.model.refresh();
  let draft: HomieEditorDraft | undefined;
  const remember = (value: HomieEditorDraft) => { draft = value; };
  try { await withDOM(async ui => {
    await ui.render(<f.Editor onDraft={remember} />);
    await ui.click('Agent model'); await ui.click('Fixture model');
    await act(async () => f.externalUpdate());
    expect(document.body.textContent).toContain('Your local draft is preserved');
    await ui.render(null); await ui.render(<f.Editor draft={draft} onDraft={remember} />);
    expect(control('Agent model').textContent).toContain('Fixture model');
    expect(submit().disabled).toBe(true);
    expect(f.saves).toHaveLength(0);
  }); } finally { f.model.dispose(); }
});

test('switching Homies on one account displays cached account and model choices without another request', async () => {
  const first = { ...specialistAgent(), accountId: 'default' };
  const second = { ...first, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Second' };
  let accountCalls = 0, modelCalls = 0;
  const api = { ...accounts, list: async () => { accountCalls++; return accounts.list(); } };
  const model = new AgentRegistryModel({ list: async () => ({ workspaceRoot: '/project', agents: [first, second] }),
    models: async () => { modelCalls++; return specialistModels(); }, onDidChange: () => () => {},
    save: async () => { throw new Error('Switching must not save settings.'); } });
  await model.refresh();
  try { await withDOM(async ui => {
    for (const agent of [first, second, first, second]) {
      await ui.render(<SpecialistAgentForm key={agent.id} agent={agent} model={model} state={model.snapshot()} accountsApi={api} />);
      expect(control('Agent account').textContent).toContain('default');
      expect(control('Agent model').textContent).toContain('Fixture model');
      expect(control('Agent reasoning effort').textContent).toContain('Medium');
      expect(control('Agent model').disabled).toBe(false);
      expect(document.body.textContent).not.toContain('Loading models');
    }
    expect(accountCalls).toBe(1); expect(modelCalls).toBe(1);
  }); } finally { model.dispose(); }
});
