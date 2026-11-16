import { expect, test } from 'bun:test';
import { RoomParticipantsPreview } from '../frontend/src/features/agent-chats/RoomParticipantsPreview';
import { ChatsView } from '../frontend/src/features/agent-chats/ChatsView';
import type { ChatMember, ChatsSnapshot } from '../shared/agent-chats';
import type { SpecialistAgent } from '../shared/agent-registry';
import { defaultAgentAvatar } from '../shared/agent-avatar';
import { withDOM } from './agent-chats-test-dom';
import { specialistAgent } from './agent-registry-fixtures';

const member = (name: string, id = name): ChatMember => ({ id, name, accountId: 'account' });

test.each([0, 1, 3, 4, 5])('%i participants show at most three Homies and the exact remaining count', async count => {
  await withDOM(async ui => {
    const members = Array.from({ length: count }, (_, index) => member(`Homie ${index + 1}`));
    await ui.render(<RoomParticipantsPreview members={members} agents={[]} />);
    const preview = document.querySelector('[aria-label="Participating Homies"]')!;
    expect(preview.querySelectorAll('[data-agent-avatar]')).toHaveLength(Math.min(count, 3));
    expect([...preview.querySelectorAll('[aria-label]')].slice(0, 3).map(node => node.getAttribute('aria-label')))
      .toEqual(members.slice(0, 3).map(value => value.name));
    const more = preview.querySelector('[aria-label$="more Homies"]');
    if (count > 3) {
      expect(more?.textContent).toBe(`+${count - 3}`);
      expect(more?.getAttribute('aria-description')).toBe(members.slice(3).map(value => value.name).join(', '));
    } else expect(more).toBeNull();
    if (!count) expect(preview.textContent).toBe('No Homies');
  });
});

test.each([
  ['Dev', 'Dev'], ['개발호미', '개발호미'], ['research', 'rese...'],
  ['개발담당호미', '개발담당...'], ['👩‍💻abcd', '👩‍💻abc...'], ['e\u0301abcd', 'e\u0301abc...'],
])('name %s truncates after four visible characters and retains its full tooltip', async (name, expected) => {
  await withDOM(async ui => {
    await ui.render(<RoomParticipantsPreview members={[member(name)]} agents={[]} />);
    const target = document.querySelector('[aria-label="Participating Homies"] > span')!;
    expect(target.textContent).toBe(expected);
    expect(target.getAttribute('aria-label')).toBe(name);
    expect(target.getAttribute('aria-description')).toBe(name);
    expect(target.hasAttribute('data-tooltip-trigger')).toBe(true);
  });
});

test('participant icons use the registered avatar only for the matching account identity', async () => {
  await withDOM(async ui => {
    const agents: SpecialistAgent[] = [{ ...specialistAgent(), id: 'dev', accountId: 'account', avatar: { character: 'comet', color: 'pink' } }];
    const render = (accountId: string) => ui.render(<RoomParticipantsPreview members={[{ ...member('Development', 'dev'), accountId }]} agents={agents} />);
    await render('account');
    expect(document.querySelector('[data-agent-avatar]')?.getAttribute('data-agent-avatar')).toBe('comet:pink');
    await render('other-account');
    const fallback = defaultAgentAvatar('dev');
    expect(document.querySelector('[data-agent-avatar]')?.getAttribute('data-agent-avatar')).toBe(`${fallback.character}:${fallback.color}`);
  });
});

test('Worker room rows replace reply previews with current participants and keep opening the room', async () => {
  await withDOM(async ui => {
    const data: ChatsSnapshot = { rooms: [{ id: 'room', name: 'Research room', workspace: '/project', engineId: 'docker:test',
      defaultAgentId: 'dev', members: [member('Old name', 'dev')], formerMembers: [member('Former Homie')], createdAt: '2026-10-03T00:00:00Z' }],
    messages: [{ id: 'reply', roomId: 'room', threadId: null, sender: 'dev', recipient: null, kind: 'message',
      text: 'This reply stays in the conversation', createdAt: '2026-10-04T00:00:00Z' }] };
    const agents: SpecialistAgent[] = [{ ...specialistAgent(), id: 'dev', accountId: 'account', name: 'Researcher',
      assignments: [{ workspaceRoot: '/project', instructions: '' }], avatar: { character: 'comet', color: 'pink' } }];
    let opened = 0;
    const sidebar = document.createElement('div'); document.body.append(sidebar);
    await ui.render(<ChatsView active={false} sidebarActive sidebarTarget={sidebar} onOpenRoom={() => { opened++; }}
      api={{ request: async () => data }} registry={{ list: async () => ({ workspaceRoot: '/project', agents }), onDidChange: () => () => {} }} />);
    const row = sidebar.querySelector('button[aria-label="Research room"]')!;
    expect(row.textContent).toContain('Rese...');
    expect(row.textContent).not.toContain('This reply');
    expect(row.textContent).not.toContain('Former Homie');
    expect(row.textContent).not.toContain('Old name');
    expect(row.querySelector('[data-agent-avatar]')?.getAttribute('data-agent-avatar')).toBe('comet:pink');
    expect(row.textContent).toMatch(/\d+[mdh]/);
    await ui.click('Research room');
    expect(opened).toBe(1);
  });
});
