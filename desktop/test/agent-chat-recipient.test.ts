import { expect, test } from 'bun:test';
import { resolveChatRecipient } from '../shared/agent-chat-recipient';
import type { RoomMessage } from '../shared/agent-chats';

const members = [
  { id: 'dev', name: 'Cheshi Development Specialist', accountId: 'account' },
  { id: 'plan', name: '기획 호미', accountId: 'account' },
];
test.each([
  '@Cheshi Development Specialist 로그인 만들어줘',
  '@Cheshi Development Specialist\n로그인 만들어줘',
  'Cheshi Development Specialist 호출하여 로그인 만들어줘',
  'Cheshi Development Specialist를 호출해서 로그인 만들어줘',
])('resolves explicit calls: %s', text => {
  expect(resolveChatRecipient(text, members)).toEqual({ recipient: 'dev', error: null });
});
test.each(['로그인 만들어줘', 'Cheshi Development Specialist는 개발 담당이야',
  'Cheshi Development Specialist 호출하지 마', 'Cheshi Development Specialist 호출해도 될까?',
  '기록: @Cheshi Development Specialist 로그인 만들어줘', '기획 호미 호출해서라는 표현을 설명해줘'])('does not infer a call from room conversation: %s', text => {
  expect(resolveChatRecipient(text, members)).toEqual({ recipient: null, error: null });
});
test('unknown mentions and duplicate names cannot silently fall back to another recipient', () => {
  expect(resolveChatRecipient('@Stranger hello', members).error).toContain('exact name');
  expect(resolveChatRecipient('@기획 호미 hello', [...members, { ...members[1]!, id: 'other' }]).error).toContain('distinct names');
});
test('uses the longest exact name and treats regular expression characters literally', () => {
  expect(resolveChatRecipient('@Cheshi Development Specialist hello', [...members, { ...members[0]!, id: 'short', name: 'Cheshi' }]).recipient).toBe('dev');
  expect(resolveChatRecipient('@Dev (A)+ hello', [{ ...members[0]!, name: 'Dev (A)+' }]).recipient).toBe('dev');
});
test('reply addresses its author or the recipient of a user request; explicit calls override it', () => {
  const reply: RoomMessage = { id: 'message', roomId: 'room', threadId: null, sender: 'dev', recipient: null,
    kind: 'message', text: 'Working', createdAt: '2026-10-05T00:00:00Z' };
  expect(resolveChatRecipient('수정해줘', members, reply).recipient).toBe('dev');
  expect(resolveChatRecipient('수정해줘', members, { ...reply, sender: 'user', recipient: 'dev' }).recipient).toBe('dev');
  expect(resolveChatRecipient('좋아요', members, { ...reply, sender: 'user' }).recipient).toBeNull();
  expect(resolveChatRecipient('기획 호미 호출해서 검토해줘', members, reply).recipient).toBe('plan');
});
