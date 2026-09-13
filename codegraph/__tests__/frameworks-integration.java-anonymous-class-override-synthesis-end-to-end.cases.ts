import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerJavaAnonymousClassOverrideSynthesisEndToEndTests(): void {


  describe('Java anonymous-class override synthesis — end-to-end', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    it('bridges an abstract base method to overrides inside `new Base() { ... }`', async () => {
      // Mirrors guava Splitter: a factory returns `new BaseIter() {
      // @Override int separatorStart(...) { ... } }`. Without anon-class
      // extraction the override is invisible — Phase 5.5 interface-impl
      // has no class to bridge — and an agent investigating `BaseIter.separatorStart`
      // can't see its real implementation without reading the file.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anon-java-'));
      fs.writeFileSync(
        path.join(tmpDir, 'Splitter.java'),
        'package com.example;\n' +
        '\n' +
        'abstract class BaseIter {\n' +
        '  abstract int separatorStart(int start);\n' +
        '}\n' +
        '\n' +
        'public class Splitter {\n' +
        '  public BaseIter make() {\n' +
        '    return new BaseIter() {\n' +
        '      @Override\n' +
        '      int separatorStart(int start) { return start + 1; }\n' +
        '    };\n' +
        '  }\n' +
        '}\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      // The anon class is extracted and contains the override.
      const anonClass = cg
        .getNodesByKind('class')
        .find((n) => /BaseIter\$anon@/.test(n.name));
      expect(anonClass, 'anonymous BaseIter subclass should be a class node').toBeDefined();

      const baseAbstract = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'com.example::BaseIter::separatorStart');
      const anonOverride = cg
        .getNodesByKind('method')
        .find(
          (n) =>
            n.name === 'separatorStart' &&
            n.qualifiedName.includes('$anon@') &&
            n.qualifiedName.startsWith('com.example::Splitter::make::')
        );
      expect(baseAbstract, 'base abstract method should be in the graph').toBeDefined();
      expect(anonOverride, 'anon-class override should be in the graph').toBeDefined();

      // Phase 5.5 interface-impl: the abstract method has a synthesized
      // `calls` edge to the anon override. Without this hop the agent
      // would have to Read the file to discover the implementation.
      const synthEdge = cg
        .getOutgoingEdges(baseAbstract!.id)
        .find((e) => e.target === anonOverride!.id && e.kind === 'calls');
      expect(synthEdge, 'BaseIter.separatorStart should bridge to anon.separatorStart').toBeDefined();
      expect(synthEdge!.provenance).toBe('heuristic');
      expect((synthEdge!.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy).toBe(
        'interface-impl'
      );

      cg.close();
    });
  });
}
