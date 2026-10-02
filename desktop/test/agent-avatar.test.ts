import { expect, test } from 'bun:test';
import { AGENT_AVATAR_CHARACTERS, AGENT_AVATAR_COLOR_NAMES, defaultAgentAvatar, parseAgentAvatar, randomAgentAvatar } from '../shared/agent-avatar';
import { agentAvatarPixels } from '../frontend/src/shared/agent-management/agentAvatarPixels';

test('every selectable character has its own complete pixel silhouette', () => {
  expect(AGENT_AVATAR_CHARACTERS).toHaveLength(24);
  expect(AGENT_AVATAR_COLOR_NAMES).toHaveLength(8);
  const shapes = AGENT_AVATAR_CHARACTERS.map(character => agentAvatarPixels[character]);
  expect(new Set(shapes.map(rows => rows.join(','))).size).toBe(24);
  for (const rows of shapes) {
    expect(rows).toHaveLength(11);
    expect(rows.every(row => Number.isInteger(row) && row >= 0 && row <= 0x7ff)).toBe(true);
    expect(rows.some(row => row !== 0)).toBe(true);
  }
});
test('legacy defaults remain stable and random rerolls produce different valid selections', () => {
  const id = 'a1234567-1234-1234-1234-123456789abc';
  expect(defaultAgentAvatar(id)).toEqual(defaultAgentAvatar(id));
  let current = defaultAgentAvatar(id);
  for (let i = 0; i < 100; i++) {
    const next = randomAgentAvatar(current);
    expect(next).not.toEqual(current);
    expect(parseAgentAvatar(next)).toEqual(next);
    current = next;
  }
});
test('avatar boundaries accept only catalog identities and strip unknown fields', () => {
  for (const value of [null, [], 'mint', { character: 'unknown', color: 'mint' },
    { character: 'sprout', color: '#fff' }, { character: 'sprout', color: 'toString' }]) {
    expect(() => parseAgentAvatar(value)).toThrow('icon');
  }
  expect(parseAgentAvatar({ character: 'sprout', color: 'mint', url: 'https://example.test/avatar.svg' }))
    .toEqual({ character: 'sprout', color: 'mint' });
});
