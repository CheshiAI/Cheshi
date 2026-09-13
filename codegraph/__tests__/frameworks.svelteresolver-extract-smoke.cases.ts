import { svelteResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerSvelteresolverExtractSmokeTests(): void {


  describe('svelteResolver.extract (smoke)', () => {
    it('returns { nodes, references } shape', () => {
      const result = svelteResolver.extract!('+page.svelte', '');
      expect(result).toHaveProperty('nodes');
      expect(result).toHaveProperty('references');
    });
  });
}
