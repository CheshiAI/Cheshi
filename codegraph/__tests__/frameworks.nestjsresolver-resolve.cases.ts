import type { Node } from '../src';
import { nestjsResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerNestjsresolverResolveTests(): void {


  describe('nestjsResolver.resolve', () => {
    const baseContext = {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    it('resolves an injected *Service reference to the class in a *.service.ts file', () => {
      const svcNode: Node = {
        id: 'class:src/users/users.service.ts:UsersService:3',
        kind: 'class',
        name: 'UsersService',
        qualifiedName: 'src/users/users.service.ts::UsersService',
        filePath: 'src/users/users.service.ts',
        language: 'typescript',
        startLine: 3,
        endLine: 3,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      const context = {
        ...baseContext,
        getNodesByName: (n: string) => (n === 'UsersService' ? [svcNode] : []),
      };
      const ref = {
        fromNodeId: 'class:src/users/users.controller.ts:UsersController:5',
        referenceName: 'UsersService',
        referenceKind: 'references' as const,
        line: 6,
        column: 4,
        filePath: 'src/users/users.controller.ts',
        language: 'typescript' as const,
      };
      const result = nestjsResolver.resolve(ref, context as any);
      expect(result?.targetNodeId).toBe(svcNode.id);
      expect(result?.resolvedBy).toBe('framework');
      expect(result?.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('returns null for a name without a provider suffix', () => {
      const ref = {
        fromNodeId: 'x',
        referenceName: 'doThing',
        referenceKind: 'references' as const,
        line: 1,
        column: 1,
        filePath: 'a.ts',
        language: 'typescript' as const,
      };
      expect(nestjsResolver.resolve(ref, baseContext as any)).toBeNull();
    });
  });
}
