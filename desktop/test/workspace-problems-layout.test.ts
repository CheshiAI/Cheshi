import { describe, expect, it } from 'bun:test';

import { clampProblemsRatio } from '../frontend/src/features/editor/workspaceProblemsLayout';

describe('Problems layout bounds', () => {
  it('keeps the Problems content visible after a tall window is shortened', () => {
    const preferredRatio = 0.1;
    expect(clampProblemsRatio(preferredRatio, 1500)).toBe(0.1);
    expect(clampProblemsRatio(preferredRatio, 500) * 500).toBe(150);
    expect(clampProblemsRatio(preferredRatio, 1500)).toBe(preferredRatio);
  });

  it('preserves the editor minimum when the Problems panel was enlarged', () => {
    const displayedRatio = clampProblemsRatio(0.9, 500);
    expect((1 - displayedRatio) * 500).toBe(120);
  });

  it('preserves an unconstrained user ratio across height changes', () => {
    expect(clampProblemsRatio(0.4, 500)).toBe(0.4);
    expect(clampProblemsRatio(0.4, 1200)).toBe(0.4);
  });

  it('shares insufficient space rather than producing negative or overflowing tracks', () => {
    expect(clampProblemsRatio(0.1, 100)).toBe(0.5);
    expect(clampProblemsRatio(0.9, 100)).toBe(0.5);
    expect(clampProblemsRatio(-1, 0)).toBe(0.1);
    expect(clampProblemsRatio(2, 0)).toBe(0.9);
  });
});
