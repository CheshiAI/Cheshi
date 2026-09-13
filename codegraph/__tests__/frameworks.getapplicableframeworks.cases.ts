import type { FrameworkResolver } from '../src/resolution';
import { getApplicableFrameworks } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerGetapplicableframeworksTests(): void {


  describe('getApplicableFrameworks', () => {
    const pyFw: FrameworkResolver = { name: 'py', languages: ['python'], detect: () => true, resolve: () => null };
    const jsFw: FrameworkResolver = { name: 'js', languages: ['javascript', 'typescript'], detect: () => true, resolve: () => null };
    const anyFw: FrameworkResolver = { name: 'any', detect: () => true, resolve: () => null };

    it('filters by language', () => {
      const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'python');
      expect(result.map(r => r.name)).toEqual(['py', 'any']);
    });

    it('returns anyFw-only when language has no matches', () => {
      const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'rust');
      expect(result.map(r => r.name)).toEqual(['any']);
    });
  });
}
