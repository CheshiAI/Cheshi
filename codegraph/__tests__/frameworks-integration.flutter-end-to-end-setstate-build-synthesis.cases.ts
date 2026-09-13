import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerFlutterEndToEndSetstateBuildSynthesisTests(): void {


  describe('Flutter end-to-end — setState→build synthesis', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    it('synthesizes a handler→build edge when a State method calls setState', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flutter-'));
      fs.writeFileSync(
        path.join(tmpDir, 'main.dart'),
        'import "package:flutter/material.dart";\n' +
        'class CounterPage extends StatefulWidget {\n' +
        '  @override\n' +
        '  State<CounterPage> createState() => _CounterPageState();\n' +
        '}\n' +
        'class _CounterPageState extends State<CounterPage> {\n' +
        '  int _count = 0;\n' +
        '  void _increment() {\n' +
        '    setState(() {\n' +
        '      _count++;\n' +
        '    });\n' +
        '  }\n' +
        '  @override\n' +
        '  Widget build(BuildContext context) {\n' +
        '    return Text("$_count");\n' +
        '  }\n' +
        '}\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const methods = cg.getNodesByKind('method');
      const increment = methods.find((n) => n.name === '_increment');
      const build = methods.find((n) => n.name === 'build');
      expect(increment).toBeDefined();
      expect(build).toBeDefined();

      // setState re-runs build (Flutter-internal, no static edge). The synthesizer
      // bridges the handler → build so the "tap → setState → rebuilt UI" flow connects.
      const edges = cg.getOutgoingEdges(increment!.id);
      const toBuild = edges.find((e) => e.target === build!.id && e.kind === 'calls');
      expect(toBuild, '_increment should reach build via setState synthesis').toBeDefined();

      cg.close();
    });
  });
}
