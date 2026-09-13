import type { Node } from '../src';
import type { FrameworkResolver, UnresolvedRef } from '../src/resolution';
import { describe, expect, it } from 'bun:test';

export function registerFrameworkresolverExtractInterfaceTests(): void {


  describe('FrameworkResolver.extract interface', () => {
    it('extract() returns { nodes, references }', () => {
      const resolver: FrameworkResolver = {
        name: 'fake',
        detect: () => true,
        resolve: () => null,
        languages: ['python'],
        extract: (_filePath: string, _content: string) => ({
          nodes: [] as Node[],
          references: [] as UnresolvedRef[],
        }),
      };
      const result = resolver.extract!('foo.py', '');
      expect(result).toEqual({ nodes: [], references: [] });
    });
  });
}
