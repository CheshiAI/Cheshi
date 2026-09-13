import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerChainedMethodCallResolutionCExtensionMethodsTests(): void {


  describe('Chained method-call resolution (C# extension methods)', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('resolves a chained extension-method call (a.b.Method()) to its definition', async () => {
      // ASP.NET DI registration: `builder.Services.AddCoreServices(...)` calls a
      // static extension method elsewhere. A multi-dot receiver chain matched no
      // method-call pattern before, so the extension method had no caller.
      fs.mkdirSync(path.join(tempDir, 'cfg'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'cfg/Ext.cs'),
        `namespace App {\n  public static class Ext {\n    public static object AddCoreServices(this object services, int x) { return services; }\n  }\n}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'Program.cs'),
        `namespace App {\n  public class Program {\n    public void Run(object builder) {\n      builder.Services.AddCoreServices(1);\n    }\n  }\n}\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const ext = cg
        .getNodesByKind('method')
        .find((n) => n.name === 'AddCoreServices')
        ?? cg.getNodesByKind('function').find((n) => n.name === 'AddCoreServices');
      expect(ext, 'AddCoreServices defined').toBeDefined();
      const callers = [...cg.getImpactRadius(ext!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(callers.some((p) => p.endsWith('Program.cs')), 'chained extension call resolves to its definition').toBe(true);
    });
  });
}
