import { expect, test } from 'bun:test';
import { formatSessionElapsedTime } from '../frontend/src/features/chat/chatSessionTime';

test.each([
  [0, '0s'], [1, '1s'], [59, '59s'], [60, '1m'], [300, '5m'],
  [3_599, '59m'], [3_600, '1h'], [32_100, '8h 55m'],
  [86_399, '23h 59m'], [86_400, '1d'], [86_460, '1d 1m'],
  [118_500, '1d 8h 55m'], [172_800, '2d'],
] as const)('formats %s elapsed seconds as %s', (seconds, expected) => {
  expect(formatSessionElapsedTime(100, (100 + seconds) * 1_000)).toBe(expected);
});

test('clamps future times and handles fractional seconds and invalid timestamps', () => {
  expect(formatSessionElapsedTime(101, 100_000)).toBe('0s');
  expect(formatSessionElapsedTime(100.5, 101_000)).toBe('0s');
  for (const invalid of [NaN, Infinity, -Infinity]) {
    expect(formatSessionElapsedTime(invalid, 100_000)).toBe('—');
    expect(formatSessionElapsedTime(100, invalid)).toBe('—');
  }
});
