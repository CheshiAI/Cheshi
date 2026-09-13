import { CodeGraph } from '../src';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerJavaAnnotationsBlastRadiusRecallTests(): void {


  describe('Java annotations (blast-radius recall)', () => {
    it('indexes @interface definitions and links @Annotation usages to them', async () => {
      const dir = createTempDir();
      try {
        fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
        // The annotation DEFINITION must be a node, and the @MyAnno usages (which
        // live inside a `modifiers` node on the class/field/method) must extract.
        fs.writeFileSync(path.join(dir, 'p', 'MyAnno.java'), `package p;\npublic @interface MyAnno { String value() default ""; }\n`);
        fs.writeFileSync(
          path.join(dir, 'p', 'User.java'),
          `package p;\n@MyAnno("c")\npublic class User {\n  @MyAnno("f") int field;\n  @MyAnno("m") void go() {}\n}\n`
        );
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('p/MyAnno.java')).toContain('p/User.java');
        cg.close();
      } finally { cleanupTempDir(dir); }
    });
  });
}
