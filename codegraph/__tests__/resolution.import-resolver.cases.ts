import { describe, expect, it } from 'bun:test';
import { Node } from '../src';
import type { UnresolvedRef } from '../src/resolution';
import { ResolutionContext } from '../src/resolution';
import { detectFrameworks, getAllFrameworkResolvers } from '../src/resolution/frameworks';
import { extractImportMappings, resolveImportPath, resolveJvmImport } from '../src/resolution/import-resolver';

export function registerImportResolverTests(): void {


  describe('Import Resolver', () => {
    it('should resolve relative import paths', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/components/utils.ts' || p === 'src/components/utils/index.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/components/utils.ts', 'src/components/utils/index.ts'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const result = resolveImportPath(
        './utils',
        'src/components/Button.ts',
        'typescript',
        context
      );

      expect(result).toBe('src/components/utils.ts');
    });

    it('should resolve parent directory imports', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/helpers.ts' || p === 'src/helpers/index.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/helpers.ts', 'src/helpers/index.ts'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const result = resolveImportPath(
        '../helpers',
        'src/components/Button.ts',
        'typescript',
        context
      );

      expect(result).toBe('src/helpers.ts');
    });

    it('should extract JS/TS import mappings', () => {
      const content = `
import { foo } from './foo';
import bar from '../bar';
import * as utils from './utils';
import { baz, qux } from './baz';
`;

      const mappings = extractImportMappings(
        'src/index.ts',
        content,
        'typescript'
      );

      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.localName === 'foo')).toBe(true);
      expect(mappings.some((m) => m.localName === 'bar')).toBe(true);
    });

    it('should extract Python import mappings', () => {
      const content = `
from utils import helper
from .models import User
import os
from ..services import auth_service
`;

      const mappings = extractImportMappings(
        'src/main.py',
        content,
        'python'
      );

      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.localName === 'helper')).toBe(true);
      expect(mappings.some((m) => m.localName === 'User')).toBe(true);
    });
  });


  describe('JVM FQN Import Resolution', () => {
    // Build a ResolutionContext stub whose getNodesByQualifiedName answers
    // from a fixed table — the only context method resolveJvmImport touches.
    const makeContext = (byQName: Record<string, Node[]>): ResolutionContext => ({
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: (q) => byQName[q] ?? [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    });
    const node = (id: string, name: string, qualifiedName: string, kind: Node['kind'] = 'class', language: Node['language'] = 'kotlin'): Node => ({
      id, kind, name, qualifiedName,
      filePath: 'Models.kt', language,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      updatedAt: 0,
    });
    const importRef = (referenceName: string, language: Node['language'] = 'kotlin'): UnresolvedRef => ({
      fromNodeId: 'caller',
      referenceName,
      referenceKind: 'imports',
      line: 1, column: 0,
      filePath: 'Caller.kt',
      language,
    });

    it('resolves a Kotlin class import by FQN regardless of filename', () => {
      const target = node('n1', 'Bar', 'com.example.foo::Bar');
      const ctx = makeContext({ 'com.example.foo::Bar': [target] });
      const result = resolveJvmImport(importRef('com.example.foo.Bar'), ctx);
      expect(result?.targetNodeId).toBe('n1');
      expect(result?.resolvedBy).toBe('import');
    });

    it('resolves a Kotlin top-level function import by FQN', () => {
      const util = node('n2', 'util', 'com.example.foo::util', 'function');
      const ctx = makeContext({ 'com.example.foo::util': [util] });
      const result = resolveJvmImport(importRef('com.example.foo.util'), ctx);
      expect(result?.targetNodeId).toBe('n2');
    });

    it('resolves a Java import by FQN', () => {
      const target = node('n3', 'Bar', 'com.example.foo::Bar', 'class', 'java');
      const ctx = makeContext({ 'com.example.foo::Bar': [target] });
      const result = resolveJvmImport(importRef('com.example.foo.Bar', 'java'), ctx);
      expect(result?.targetNodeId).toBe('n3');
    });

    it('resolves cross-language: Kotlin importing a Java class', () => {
      // The Kotlin file declares `import com.example.JavaBar` — the target is
      // a Java class node. JVM interop means the resolver doesn't care about
      // the source language of the target, only that the FQN matches.
      const target = node('n4', 'JavaBar', 'com.example::JavaBar', 'class', 'java');
      const ctx = makeContext({ 'com.example::JavaBar': [target] });
      const result = resolveJvmImport(importRef('com.example.JavaBar'), ctx);
      expect(result?.targetNodeId).toBe('n4');
    });

    it('disambiguates a name collision across packages', () => {
      // Two classes named `Bar` in different packages. Each import resolves
      // to the one whose FQN matches — not to "whichever was found first".
      const barA = node('n5a', 'Bar', 'com.example.alpha::Bar');
      const barB = node('n5b', 'Bar', 'com.example.beta::Bar');
      const ctx = makeContext({
        'com.example.alpha::Bar': [barA],
        'com.example.beta::Bar': [barB],
      });
      expect(resolveJvmImport(importRef('com.example.alpha.Bar'), ctx)?.targetNodeId).toBe('n5a');
      expect(resolveJvmImport(importRef('com.example.beta.Bar'), ctx)?.targetNodeId).toBe('n5b');
    });

    it('returns null for wildcard imports', () => {
      const ctx = makeContext({});
      expect(resolveJvmImport(importRef('com.example.foo.*'), ctx)).toBeNull();
    });

    it('returns null for unqualified names', () => {
      // A single-segment name has no package; nothing to look up by FQN.
      const ctx = makeContext({ 'Bar': [node('n6', 'Bar', 'Bar')] });
      expect(resolveJvmImport(importRef('Bar'), ctx)).toBeNull();
    });

    it('returns null for non-JVM languages', () => {
      const target = node('n7', 'Bar', 'com.example::Bar');
      const ctx = makeContext({ 'com.example::Bar': [target] });
      expect(resolveJvmImport(importRef('com.example.Bar', 'typescript'), ctx)).toBeNull();
    });

    it('returns null for non-imports reference kinds', () => {
      // The resolver intentionally only acts on `imports` refs; ordinary
      // `calls`/`extends` refs fall through to the framework + name-matcher
      // strategies.
      const target = node('n8', 'Bar', 'com.example::Bar');
      const ctx = makeContext({ 'com.example::Bar': [target] });
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'com.example.Bar',
        referenceKind: 'calls', line: 1, column: 0,
        filePath: 'Caller.kt', language: 'kotlin',
      };
      expect(resolveJvmImport(ref, ctx)).toBeNull();
    });

    it('returns null when the FQN is not in the index', () => {
      const ctx = makeContext({});
      expect(resolveJvmImport(importRef('com.example.Unknown'), ctx)).toBeNull();
    });
  });


  describe('Framework Detection', () => {
    it('should detect React framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({
              dependencies: { react: '^18.0.0' },
            });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/App.tsx'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'react')).toBe(true);
    });

    it('should detect Express framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({
              dependencies: { express: '^4.18.0' },
            });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/app.js'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'express')).toBe(true);
    });

    it('should detect Laravel framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'artisan',
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['artisan', 'app/Http/Kernel.php'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'laravel')).toBe(true);
    });

    it('should return all framework resolvers', () => {
      const resolvers = getAllFrameworkResolvers();
      expect(resolvers.length).toBeGreaterThan(0);
      expect(resolvers.some((r) => r.name === 'react')).toBe(true);
      expect(resolvers.some((r) => r.name === 'express')).toBe(true);
      expect(resolvers.some((r) => r.name === 'laravel')).toBe(true);
    });
  });


  describe('React Framework Resolver', () => {
    it('should resolve React component references', () => {
      const mockNodes: Node[] = [
        {
          id: 'component:src/Button.tsx:Button:5',
          kind: 'component',
          name: 'Button',
          qualifiedName: 'src/Button.tsx::Button',
          filePath: 'src/Button.tsx',
          language: 'tsx',
          startLine: 5,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp === 'src/Button.tsx' ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/Button.tsx', 'src/App.tsx'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');
      expect(reactResolver).toBeDefined();

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'Button',
        referenceKind: 'references' as const,
        line: 10,
        column: 5,
        filePath: 'src/App.tsx',
        // Refs extracted from .tsx files carry language 'tsx' — component
        // resolution is gated to JSX-capable refs (#764: PascalCase TYPE refs
        // from plain .ts files were resolving to arbitrary same-named classes).
        language: 'tsx' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('component:src/Button.tsx:Button:5');

      // The same PascalCase name referenced from a plain .ts file is a TYPE
      // reference, not a component usage — component resolution must decline
      // and leave it to proximity-aware name matching (#764: a .ts GraphQL
      // types file's own `Account` alias was losing to an arbitrary same-named
      // class in another monorepo package).
      const tsRef = { ...ref, filePath: 'src/models.ts', language: 'typescript' as const };
      expect(reactResolver!.resolve(tsRef, context)).toBeNull();
    });

    it('should resolve custom hook references', () => {
      const mockNodes: Node[] = [
        {
          id: 'hook:src/hooks/useAuth.ts:useAuth:1',
          kind: 'function',
          name: 'useAuth',
          qualifiedName: 'src/hooks/useAuth.ts::useAuth',
          filePath: 'src/hooks/useAuth.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp.includes('useAuth') ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/hooks/useAuth.ts'],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'useAuth',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'src/App.tsx',
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('hook:src/hooks/useAuth.ts:useAuth:1');
    });
  });

}
