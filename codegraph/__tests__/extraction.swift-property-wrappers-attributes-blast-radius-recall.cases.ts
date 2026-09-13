import { CodeGraph } from '../src';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerSwiftPropertyWrappersAttributesBlastRadiusRecallTests(): void {


  describe('Swift property wrappers / attributes (blast-radius recall)', () => {
    it('links a @propertyWrapper usage to the wrapper type', async () => {
      const dir = createTempDir();
      try {
        fs.mkdirSync(path.join(dir, 'Sources', 'M'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'Sources', 'M', 'Wrap.swift'), `@propertyWrapper\npublic struct Argument<T> { public var wrappedValue: T }\n`);
        // `@Argument` is a Swift attribute on a stored property — it lives in the
        // property's `modifiers` and Swift doesn't extract instance properties as
        // their own nodes, so without the fix the wrapper type has no users.
        fs.writeFileSync(path.join(dir, 'Sources', 'M', 'Cmd.swift'), `public struct MyCommand {\n  @Argument var name: String\n  @Argument var count: Int\n}\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('Sources/M/Wrap.swift')).toContain('Sources/M/Cmd.swift');
        cg.close();
      } finally { cleanupTempDir(dir); }
    });
  });
}
