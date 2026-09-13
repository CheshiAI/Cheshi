import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerCFreeFunctionNameExtractionTests(): void {


  describe('C++ free-function name extraction', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('names a free function correctly when it has qualified-type params or a trailing return type', async () => {
      const src = path.join(tempDir, 'src');
      fs.mkdirSync(src, { recursive: true });

      // TableFileName has a `const std::string&` parameter; BuildName uses an
      // `auto … -> std::string` trailing return type. Both used to be named
      // `string` (picked up from the parameter / return type), so callers never
      // resolved and the defining file looked like nothing depended on it.
      fs.writeFileSync(
        path.join(src, 'names.cc'),
        `#include <string>

std::string TableFileName(const std::string& dbname, int number) {
  return dbname;
}

auto BuildName(const std::string& a) -> std::string {
  return a;
}
`
      );
      fs.writeFileSync(
        path.join(src, 'user.cc'),
        `#include <string>

std::string use() {
  return TableFileName("db", 1) + BuildName("x");
}
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      // The functions are extracted under their real names, not `string`.
      const fns = cg.getNodesByKind('function');
      const tableFn = fns.find((n) => n.name === 'TableFileName');
      const buildFn = fns.find((n) => n.name === 'BuildName');
      expect(tableFn, 'TableFileName extracted (not "string")').toBeDefined();
      expect(buildFn, 'BuildName extracted (not "string")').toBeDefined();

      // And the cross-file calls resolve to them, so editing names.cc surfaces user.cc.
      for (const fn of [tableFn!, buildFn!]) {
        const reached = [...cg.getImpactRadius(fn.id, 3).nodes.values()].map((n) => n.filePath ?? '');
        expect(reached.some((p) => p.endsWith('user.cc')), `${fn.name} should be called from user.cc`).toBe(true);
      }
    });
  });
}
