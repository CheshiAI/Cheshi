import { astroResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerAstroresolverResolveAstroGlobalAndVirtualModulesTests(): void {


  describe('astroResolver.resolve — Astro global and virtual modules', () => {
    const ctx = {} as never;
    const baseRef = {
      fromNodeId: 'component:a',
      line: 1,
      column: 0,
      filePath: 'src/pages/index.astro',
      language: 'astro',
    };

    it('claims Astro.* global references as framework-provided', () => {
      const res = astroResolver.resolve(
        { ...baseRef, referenceName: 'Astro.props', referenceKind: 'references' } as never,
        ctx
      );
      expect(res?.resolvedBy).toBe('framework');
      expect(res?.confidence).toBe(1.0);
    });

    it('claims astro:content virtual module imports', () => {
      const res = astroResolver.resolve(
        { ...baseRef, referenceName: 'astro:content', referenceKind: 'imports' } as never,
        ctx
      );
      expect(res?.resolvedBy).toBe('framework');
    });

    it('leaves ordinary names alone', () => {
      const res = astroResolver.resolve(
        { ...baseRef, referenceName: 'astrolabe', referenceKind: 'calls' } as never,
        { getNodesByName: () => [] } as never
      );
      expect(res).toBeNull();
    });
  });
}
