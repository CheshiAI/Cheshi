import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerCRecordsBlastRadiusRecallTests(): void {


  describe('C# records (blast-radius recall)', () => {
    // Records are ubiquitous in modern C# (DTOs, value objects, CQRS messages),
    // but `record` / `record struct` declarations weren't extracted as types — so
    // every reference, generic-type-argument, and `new` of a record dropped on the
    // floor and the defining file showed 0 dependents. (#237)
    it('extracts a record as a graph node (record class + record struct)', () => {
      const r = extractFromSource('r.cs', `namespace P;\npublic record Box(int N);\npublic record struct Pt(int X);\n`);
      expect(r.nodes.find((n) => n.name === 'Box' && (n.kind === 'class' || n.kind === 'struct'))).toBeDefined();
      expect(r.nodes.find((n) => n.name === 'Pt' && (n.kind === 'class' || n.kind === 'struct'))).toBeDefined();
    });

    it('resolves references / instantiations of a record across files', async () => {
      const dir = createTempDir();
      try {
        fs.writeFileSync(path.join(dir, 'types.cs'), `namespace P;\npublic record Box(int N);\n`);
        // Box is used as a generic type argument and instantiated — both require
        // Box to be a node to resolve.
        fs.writeFileSync(
          path.join(dir, 'use.cs'),
          `using System.Collections.Generic;\nnamespace P;\npublic class User {\n    public IEnumerable<Box> Boxes { get; }\n    public Box Make() => new Box(1);\n}\n`
        );
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('types.cs')).toContain('use.cs');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });
  });
}
