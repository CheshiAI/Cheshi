import type { Node } from '../src';
import { rustResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerRustresolverResolveCargoWorkspaceCratesTests(): void {


  describe('rustResolver.resolve cargo workspace crates', () => {
    it('resolves crate name from workspace member lib.rs', () => {
      const workspaceCargo = `
[workspace]
members = ["crates/mytool-core", "crates/mytool-fetcher"]
`;
      const coreCargo = `
[package]
name = "mytool-core"
version = "0.1.0"
`;
      const libNode: Node = {
        id: 'module:crates/mytool-core/src/lib.rs:mytool_core:1',
        kind: 'module',
        name: 'mytool_core',
        qualifiedName: 'crates/mytool-core/src/lib.rs::mytool_core',
        filePath: 'crates/mytool-core/src/lib.rs',
        language: 'rust',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      //noinspection DuplicatedCode
      const context = {
        getNodesInFile: (fp: string) => (fp === 'crates/mytool-core/src/lib.rs' ? [libNode] : []),
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p: string) => (
          p === 'Cargo.toml' ||
          p === 'crates/mytool-core/Cargo.toml' ||
          p === 'crates/mytool-core/src/lib.rs'
        ),
        readFile: (p: string) => {
          if (p === 'Cargo.toml') return workspaceCargo;
          if (p === 'crates/mytool-core/Cargo.toml') return coreCargo;
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => [
          'Cargo.toml',
          'crates/mytool-core/Cargo.toml',
          'crates/mytool-core/src/lib.rs',
        ],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const ref = {
        fromNodeId: 'fn:crates/mytool-fetcher/src/main.rs:main:1',
        referenceName: 'mytool_core',
        referenceKind: 'references' as const,
        line: 1,
        column: 1,
        filePath: 'crates/mytool-fetcher/src/main.rs',
        language: 'rust' as const,
      };

      const result = rustResolver.resolve(ref, context);
      expect(result?.targetNodeId).toBe(libNode.id);
      expect(result?.resolvedBy).toBe('framework');
      // Workspace-manifest hits are unambiguous and must beat name-matcher's
      // self-file matches (0.7) so cross-crate `imports` edges materialize.
      expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('resolves crate name from workspace member main.rs when lib.rs is absent', () => {
      const workspaceCargo = `
[workspace]
members = [
  "crates/mytool-runner",
]
`;
      const runnerCargo = `
[package]
name = "mytool-runner"
version = "0.1.0"
`;
      const mainNode: Node = {
        id: 'module:crates/mytool-runner/src/main.rs:mytool_runner:1',
        kind: 'module',
        name: 'mytool_runner',
        qualifiedName: 'crates/mytool-runner/src/main.rs::mytool_runner',
        filePath: 'crates/mytool-runner/src/main.rs',
        language: 'rust',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      //noinspection DuplicatedCode
      const context = {
        getNodesInFile: (fp: string) => (fp === 'crates/mytool-runner/src/main.rs' ? [mainNode] : []),
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p: string) => (
          p === 'Cargo.toml' ||
          p === 'crates/mytool-runner/Cargo.toml' ||
          p === 'crates/mytool-runner/src/main.rs'
        ),
        readFile: (p: string) => {
          if (p === 'Cargo.toml') return workspaceCargo;
          if (p === 'crates/mytool-runner/Cargo.toml') return runnerCargo;
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => [
          'Cargo.toml',
          'crates/mytool-runner/Cargo.toml',
          'crates/mytool-runner/src/main.rs',
        ],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      const ref = {
        fromNodeId: 'fn:crates/mytool-runner/src/main.rs:main:1',
        referenceName: 'mytool_runner',
        referenceKind: 'references' as const,
        line: 1,
        column: 1,
        filePath: 'crates/mytool-runner/src/main.rs',
        language: 'rust' as const,
      };

      const result = rustResolver.resolve(ref, context);
      expect(result?.targetNodeId).toBe(mainNode.id);
      expect(result?.resolvedBy).toBe('framework');
    });

    it('resolves crate name when members uses a glob (crates/*)', () => {
      const workspaceCargo = `
[workspace]
members = ["crates/*"]
`;
      const fooCargo = `
[package]
name = "mytool-foo"
version = "0.1.0"
`;
      const barCargo = `
[package]
name = "mytool-bar"
version = "0.1.0"
`;
      const fooLib: Node = {
        id: 'module:crates/mytool-foo/src/lib.rs:mytool_foo:1',
        kind: 'module',
        name: 'mytool_foo',
        qualifiedName: 'crates/mytool-foo/src/lib.rs::mytool_foo',
        filePath: 'crates/mytool-foo/src/lib.rs',
        language: 'rust',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      const barLib: Node = {
        id: 'module:crates/mytool-bar/src/lib.rs:mytool_bar:1',
        kind: 'module',
        name: 'mytool_bar',
        qualifiedName: 'crates/mytool-bar/src/lib.rs::mytool_bar',
        filePath: 'crates/mytool-bar/src/lib.rs',
        language: 'rust',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const filesByPath: Record<string, string> = {
        'Cargo.toml': workspaceCargo,
        'crates/mytool-foo/Cargo.toml': fooCargo,
        'crates/mytool-bar/Cargo.toml': barCargo,
      };
      const nodesByFile: Record<string, Node[]> = {
        'crates/mytool-foo/src/lib.rs': [fooLib],
        'crates/mytool-bar/src/lib.rs': [barLib],
      };
      const dirsByPath: Record<string, string[]> = {
        '.': ['crates'],
        crates: ['mytool-foo', 'mytool-bar'],
        'crates/mytool-foo': ['src'],
        'crates/mytool-bar': ['src'],
      };

      //noinspection DuplicatedCode
      const context = {
        getNodesInFile: (fp: string) => nodesByFile[fp] ?? [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p: string) => (
          Object.prototype.hasOwnProperty.call(filesByPath, p) ||
          Object.prototype.hasOwnProperty.call(nodesByFile, p)
        ),
        readFile: (p: string) => filesByPath[p] ?? null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [
          'Cargo.toml',
          ...Object.keys(filesByPath).filter((p) => p !== 'Cargo.toml'),
          ...Object.keys(nodesByFile),
        ],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
        //noinspection JSUnusedGlobalSymbols
        listDirectories: (rel: string) => dirsByPath[rel] ?? [],
      };

      const fooRef = {
        fromNodeId: 'fn:crates/mytool-bar/src/lib.rs:other:1',
        referenceName: 'mytool_foo',
        referenceKind: 'references' as const,
        line: 1,
        column: 1,
        filePath: 'crates/mytool-bar/src/lib.rs',
        language: 'rust' as const,
      };
      const barRef = {
        fromNodeId: 'fn:crates/mytool-foo/src/lib.rs:other:1',
        referenceName: 'mytool_bar',
        referenceKind: 'references' as const,
        line: 1,
        column: 1,
        filePath: 'crates/mytool-foo/src/lib.rs',
        language: 'rust' as const,
      };

      void context.listDirectories('.');
      expect(rustResolver.resolve(fooRef, context)?.targetNodeId).toBe(fooLib.id);
      expect(rustResolver.resolve(barRef, context)?.targetNodeId).toBe(barLib.id);
    });

    it('resolves crate name when members uses a name glob at root (helix-*)', () => {
      const workspaceCargo = `
[workspace]
members = ["helix-*"]
`;
      const coreCargo = `
[package]
name = "helix-core"
version = "0.1.0"
`;
      const coreLib: Node = {
        id: 'module:helix-core/src/lib.rs:helix_core:1',
        kind: 'module',
        name: 'helix_core',
        qualifiedName: 'helix-core/src/lib.rs::helix_core',
        filePath: 'helix-core/src/lib.rs',
        language: 'rust',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const filesByPath: Record<string, string> = {
        'Cargo.toml': workspaceCargo,
        'helix-core/Cargo.toml': coreCargo,
      };
      const nodesByFile: Record<string, Node[]> = {
        'helix-core/src/lib.rs': [coreLib],
      };
      const dirsByPath: Record<string, string[]> = {
        '.': ['helix-core', 'docs', 'target'],
        'helix-core': ['src'],
      };

      //noinspection DuplicatedCode
      const context = {
        getNodesInFile: (fp: string) => nodesByFile[fp] ?? [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p: string) => (
          Object.prototype.hasOwnProperty.call(filesByPath, p) ||
          Object.prototype.hasOwnProperty.call(nodesByFile, p)
        ),
        readFile: (p: string) => filesByPath[p] ?? null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [
          'Cargo.toml',
          ...Object.keys(filesByPath).filter((p) => p !== 'Cargo.toml'),
          ...Object.keys(nodesByFile),
        ],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
        //noinspection JSUnusedGlobalSymbols
        listDirectories: (rel: string) => dirsByPath[rel] ?? [],
      };

      const ref = {
        fromNodeId: 'fn:helix-core/src/lib.rs:other:1',
        referenceName: 'helix_core',
        referenceKind: 'references' as const,
        line: 1,
        column: 1,
        filePath: 'helix-core/src/lib.rs',
        language: 'rust' as const,
      };

      void context.listDirectories('.');
      expect(rustResolver.resolve(ref, context)?.targetNodeId).toBe(coreLib.id);
    });
  });
}
