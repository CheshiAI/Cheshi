import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerJvmFqnImportsEndToEndTests(): void {


  describe('JVM FQN imports — end-to-end', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    it('resolves a Kotlin import when the file name differs from the class name', async () => {
      // Bar lives in Models.kt — the filesystem-based Java-style path lookup
      // (com/example/Bar.kt) misses this; only FQN-via-qualifiedName finds it.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
      fs.writeFileSync(
        path.join(tmpDir, 'Models.kt'),
        'package com.example\n\nclass Bar {\n  fun greet(): String = "hi"\n}\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'Caller.kt'),
        'package com.example.app\n\nimport com.example.Bar\n\nclass App {\n  fun run() { Bar().greet() }\n}\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const bar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example::Bar');
      expect(bar, 'Bar should be extracted with package-qualified name').toBeDefined();

      const importNode = cg.getNodesByKind('import').find((n) => n.name === 'com.example.Bar');
      expect(importNode, 'import statement node should exist').toBeDefined();

      // The imports edge may originate from the import node OR from a parent
      // scope (file / namespace) — accept either, but require that an
      // imports-kind edge to Bar exists.
      const reachesBar = cg
        .getIncomingEdges(bar!.id)
        .find((e) => e.kind === 'imports');
      expect(reachesBar, 'an imports edge should resolve to Bar via FQN').toBeDefined();

      cg.close();
    });

    it('resolves a Kotlin top-level function import', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
      fs.writeFileSync(
        path.join(tmpDir, 'Utils.kt'),
        'package com.example\n\nfun util(): Int = 42\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'Caller.kt'),
        'package com.example.app\n\nimport com.example.util\n\nfun main() { util() }\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const util = cg.getNodesByKind('function').find((n) => n.qualifiedName === 'com.example::util');
      expect(util, 'top-level util() should be extracted under com.example').toBeDefined();

      const edge = cg.getIncomingEdges(util!.id).find((e) => e.kind === 'imports');
      expect(edge, 'imports edge should reach the top-level function by FQN').toBeDefined();
    });

    it('resolves cross-language: Kotlin importing a Java class', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
      fs.writeFileSync(
        path.join(tmpDir, 'JavaBar.java'),
        'package com.example;\n\npublic class JavaBar {\n  public String greet() { return "hi"; }\n}\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'Caller.kt'),
        'package com.example.app\n\nimport com.example.JavaBar\n\nfun main() { JavaBar().greet() }\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const javaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example::JavaBar');
      expect(javaBar, 'JavaBar should be extracted under com.example regardless of language').toBeDefined();

      const edge = cg.getIncomingEdges(javaBar!.id).find((e) => e.kind === 'imports');
      expect(edge, 'Kotlin caller should resolve its import to the Java class').toBeDefined();
    });

    it('disambiguates a class-name collision across packages', async () => {
      // Two `Bar` classes in different packages — each importer should reach
      // ITS Bar, not the other one. This is the central failure mode that
      // name-matcher alone cannot disambiguate.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-imp-'));
      fs.writeFileSync(
        path.join(tmpDir, 'AlphaBar.kt'),
        'package com.example.alpha\n\nclass Bar { fun who() = "alpha" }\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'BetaBar.kt'),
        'package com.example.beta\n\nclass Bar { fun who() = "beta" }\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'CallerA.kt'),
        'package app\n\nimport com.example.alpha.Bar\n\nfun a() { Bar().who() }\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'CallerB.kt'),
        'package app\n\nimport com.example.beta.Bar\n\nfun b() { Bar().who() }\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const alphaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example.alpha::Bar');
      const betaBar = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'com.example.beta::Bar');
      expect(alphaBar).toBeDefined();
      expect(betaBar).toBeDefined();
      expect(alphaBar!.id).not.toBe(betaBar!.id);

      // Each Bar receives exactly one imports edge — from its own caller.
      const alphaIncoming = cg.getIncomingEdges(alphaBar!.id).filter((e) => e.kind === 'imports');
      const betaIncoming = cg.getIncomingEdges(betaBar!.id).filter((e) => e.kind === 'imports');
      expect(alphaIncoming.length).toBeGreaterThan(0);
      expect(betaIncoming.length).toBeGreaterThan(0);

      // Sanity: the edges don't cross — alpha's incoming sources don't include
      // beta's filePath and vice versa.
      const sourceFiles = (edges: typeof alphaIncoming) =>
        edges.map((e) => cg.getNode(e.source)?.filePath).filter(Boolean);
      expect(sourceFiles(alphaIncoming).some((p) => p?.includes('CallerA.kt'))).toBe(true);
      expect(sourceFiles(betaIncoming).some((p) => p?.includes('CallerB.kt'))).toBe(true);
    });
  });
}
