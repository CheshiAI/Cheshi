import { expect, test } from 'bun:test';
import { chatGreeting } from '../frontend/src/features/chat/chatGreeting';

for (const [hour, greeting] of [
  [0, 'You’re up late'], [4, 'You’re up late'], [5, 'Good morning'],
  [11, 'Good morning'], [12, 'Good afternoon'], [17, 'Good afternoon'],
  [18, 'Good evening'], [23, 'Good evening'],
] as const) {
  test(`uses the local greeting at hour ${hour}`, () => {
    expect(chatGreeting(new Date(2026, 8, 8, hour), '  Alex  ')).toBe(`${greeting}, Alex.`);
  });
}

test('omits the name cleanly when the OS account name is unavailable', () => {
  expect(chatGreeting(new Date(2026, 8, 8, 9), ' ')).toBe('Good morning.');
  expect(chatGreeting(new Date(2026, 8, 8, 2), ' ')).toBe('You’re up late.');
});
