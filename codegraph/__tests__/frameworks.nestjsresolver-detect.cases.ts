import { nestjsResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerNestjsresolverDetectTests(): void {


  describe('nestjsResolver.detect', () => {
    const baseContext = {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/test',
      getAllFiles: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    it('detects @nestjs/* in package.json', () => {
      //noinspection DuplicatedCode
      const context = {
        ...baseContext,
        readFile: (p: string) =>
          p === 'package.json'
            ? JSON.stringify({ dependencies: { '@nestjs/common': '^10.0.0' } })
            : null,
      };
      expect(nestjsResolver.detect(context as any)).toBe(true);
    });

    it('detects @Controller in a *.controller.ts file when package.json is absent', () => {
      //noinspection DuplicatedCode
      const context = {
        ...baseContext,
        getAllFiles: () => ['src/users.controller.ts'],
        readFile: (p: string) =>
          p === 'src/users.controller.ts'
            ? `@Controller('users')\nexport class UsersController {}`
            : null,
      };
      expect(nestjsResolver.detect(context as any)).toBe(true);
    });

    it('returns false for a non-Nest project', () => {
      const context = {
        ...baseContext,
        readFile: (p: string) =>
          p === 'package.json' ? JSON.stringify({ dependencies: { express: '^4' } }) : null,
      };
      expect(nestjsResolver.detect(context as any)).toBe(false);
    });
  });
}
