import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerKotlinMultiplatformExpectActualTests(): void {


  describe('Kotlin Multiplatform expect/actual', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links expect declarations to platform actual implementations and surfaces them in impact', async () => {
      const common = path.join(tempDir, 'src', 'commonMain');
      const jvm = path.join(tempDir, 'src', 'jvmMain');
      fs.mkdirSync(common, { recursive: true });
      fs.mkdirSync(jvm, { recursive: true });

      // common source set: expect declarations + a caller that uses them
      fs.writeFileSync(
        path.join(common, 'SystemProps.kt'),
        `package demo.internal

expect fun systemProp(name: String): String?

expect class Platform {
    fun describe(): String
}
`
      );
      fs.writeFileSync(
        path.join(common, 'Caller.kt'),
        `package demo

import demo.internal.systemProp
import demo.internal.Platform

fun useIt(): String {
    val v = systemProp("os.name")
    return Platform().describe() + v
}
`
      );
      // jvm source set: actual implementations
      fs.writeFileSync(
        path.join(jvm, 'SystemProps.kt'),
        `package demo.internal

actual fun systemProp(name: String): String? = System.getProperty(name)

actual class Platform {
    actual fun describe(): String = "JVM"
}
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      // The expect/actual markers are captured onto the node's decorators.
      const fns = cg.getNodesByKind('function');
      const actualFn = fns.find(
        (n) => n.name === 'systemProp' && n.decorators?.includes('actual')
      );
      const expectFn = fns.find(
        (n) => n.name === 'systemProp' && n.decorators?.includes('expect')
      );
      expect(actualFn).toBeDefined();
      expect(expectFn).toBeDefined();
      expect(actualFn!.filePath).not.toBe(expectFn!.filePath);

      // Editing the JVM actual must surface the common expect AND its caller —
      // before the expect/actual bridge the actual had zero dependents.
      const impact = cg.getImpactRadius(actualFn!.id, 3);
      const impacted = [...impact.nodes.values()].map((n) => n.name);
      expect(impacted).toContain('systemProp'); // the common expect
      expect(impacted).toContain('useIt'); // the caller, reached transitively

      // The bridging edge is a heuristic `calls` edge tagged by the synthesizer.
      const bridge = impact.edges.find(
        (e) =>
          e.target === actualFn!.id &&
          e.provenance === 'heuristic' &&
          (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy ===
          'kotlin-expect-actual'
      );
      expect(bridge).toBeDefined();
      expect(bridge!.source).toBe(expectFn!.id);
    });

    it('links an expect class to an actual typealias (different node kinds)', async () => {
      const common = path.join(tempDir, 'src', 'commonMain');
      const jvm = path.join(tempDir, 'src', 'jvmMain');
      fs.mkdirSync(common, { recursive: true });
      fs.mkdirSync(jvm, { recursive: true });

      fs.writeFileSync(
        path.join(common, 'Lock.kt'),
        `package demo

expect class Lock {
    fun acquire()
}
`
      );
      fs.writeFileSync(
        path.join(jvm, 'Lock.kt'),
        `package demo

actual typealias Lock = java.util.concurrent.locks.ReentrantLock
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const aliasNode = cg
        .getNodesByKind('type_alias')
        .find((n) => n.name === 'Lock' && n.decorators?.includes('actual'));
      expect(aliasNode).toBeDefined();

      // The actual typealias is now a cross-file dependency target (linked from
      // the expect class), so it participates in impact rather than being orphaned.
      const impact = cg.getImpactRadius(aliasNode!.id, 3);
      const bridge = impact.edges.find(
        (e) =>
          e.target === aliasNode!.id &&
          (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy ===
          'kotlin-expect-actual'
      );
      expect(bridge).toBeDefined();
    });
  });
}
