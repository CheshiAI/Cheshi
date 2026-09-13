import { ALL_TARGETS, getTarget, resolveTargetFlag } from '../src/installer/targets/registry';
import { describe, expect, it } from 'bun:test';

export function registerInstallerTargetsRegistryTests(): void {


  describe('Installer targets — registry', () => {
    it('getTarget returns the right target for each id', () => {
      expect(getTarget('claude')?.id).toBe('claude');
      expect(getTarget('cursor')?.id).toBe('cursor');
      expect(getTarget('codex')?.id).toBe('codex');
      expect(getTarget('opencode')?.id).toBe('opencode');
      expect(getTarget('hermes')?.id).toBe('hermes');
      expect(getTarget('gemini')?.id).toBe('gemini');
      expect(getTarget('antigravity')?.id).toBe('antigravity');
      expect(getTarget('kiro')?.id).toBe('kiro');
      expect(getTarget('not-a-real-target')).toBeUndefined();
    });

    it('resolveTargetFlag handles auto/all/none/csv', () => {
      expect(resolveTargetFlag('none', 'global')).toEqual([]);
      expect(resolveTargetFlag('all', 'global').length).toBe(ALL_TARGETS.length);
      const csv = resolveTargetFlag('claude,cursor', 'global');
      expect(csv.map((t) => t.id)).toEqual(['claude', 'cursor']);
    });

    it('resolveTargetFlag throws on unknown id', () => {
      expect(() => resolveTargetFlag('claude,bogus', 'global')).toThrow(/Unknown --target/);
    });
  });
}
