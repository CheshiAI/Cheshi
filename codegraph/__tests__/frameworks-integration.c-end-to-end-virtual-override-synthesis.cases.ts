import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerCEndToEndVirtualOverrideSynthesisTests(): void {


  describe('C++ end-to-end — virtual override synthesis', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    it('resolves callers through typed object pointers', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
      let cg: CodeGraph | undefined;
      try {
        fs.writeFileSync(
          path.join(tmpDir, 'detect.hpp'),
          'class CDetect {\n' +
          ' public:\n' +
          '  int Processing();\n' +
          '};\n' +
          'class CDetector {\n' +
          ' private:\n' +
          '  CDetect* m_cpAlg = nullptr;\n' +
          ' public:\n' +
          '  int Run();\n' +
          '  int Flush();\n' +
          '};\n'
        );
        fs.writeFileSync(
          path.join(tmpDir, 'detect.cpp'),
          '#include "detect.hpp"\n' +
          'int CDetector::Run() { return m_cpAlg->Processing(); }\n' +
          'int CDetector::Flush() { return m_cpAlg->Processing(); }\n' +
          'int CDetect::Processing() { return 0; }\n'
        );

        cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        const processing = cg
          .getNodesByKind('method')
          .find((n) => n.qualifiedName.endsWith('CDetect::Processing'));
        expect(processing).toBeDefined();

        const callers = cg.getCallers(processing!.id).map((c) => c.node.qualifiedName);
        expect(callers).toContain('CDetector::Run');
        expect(callers).toContain('CDetector::Flush');

        const runMethod = cg
          .getNodesByKind('method')
          .find((n) => n.qualifiedName.endsWith('CDetector::Run'));
        expect(runMethod).toBeDefined();
        const callees = cg.getCallees(runMethod!.id).map((c) => c.node.qualifiedName);
        expect(callees).toContain('CDetect::Processing');
      } finally {
        cg?.close();
      }
    });

    it('resolves typed pointer callers when the method name is ambiguous and the call sits inside a return/declaration', async () => {
      // Regression: an earlier version of the C++ receiver-type inference matched
      // the call line itself (`return m_cpAlg->Processing()`) and treated `return`
      // as the type, OR grabbed `int r =` as a type from the prefix. With Strategy
      // 3's "unique method name" fallback, the original issue example resolved
      // anyway — but as soon as two classes share a method name (very common in
      // real C++), both calls go unresolved.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
      let cg: CodeGraph | undefined;
      try {
        fs.writeFileSync(
          path.join(tmpDir, 'detect.hpp'),
          'class CDetect { public: int Processing(); };\n' +
          'class CWidget { public: int Processing(); };\n' +
          'class CDetector {\n' +
          ' private:\n' +
          '  CDetect* m_cpAlg = nullptr;\n' +
          ' public:\n' +
          '  int RunReturn();\n' +
          '  int RunAssign();\n' +
          '};\n'
        );
        fs.writeFileSync(
          path.join(tmpDir, 'detect.cpp'),
          '#include "detect.hpp"\n' +
          'int CDetector::RunReturn() { return m_cpAlg->Processing(); }\n' +
          'int CDetector::RunAssign() { int r = m_cpAlg->Processing(); return r; }\n' +
          'int CDetect::Processing() { return 0; }\n' +
          'int CWidget::Processing() { return 0; }\n'
        );

        cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        const detectProc = cg
          .getNodesByKind('method')
          .find((n) => n.qualifiedName === 'CDetect::Processing');
        const widgetProc = cg
          .getNodesByKind('method')
          .find((n) => n.qualifiedName === 'CWidget::Processing');
        expect(detectProc).toBeDefined();
        expect(widgetProc).toBeDefined();

        const detectCallers = cg.getCallers(detectProc!.id).map((c) => c.node.qualifiedName);
        expect(detectCallers).toContain('CDetector::RunReturn');
        expect(detectCallers).toContain('CDetector::RunAssign');

        // CWidget::Processing is never called — calls must NOT misroute here.
        const widgetCallers = cg.getCallers(widgetProc!.id).map((c) => c.node.qualifiedName);
        expect(widgetCallers).not.toContain('CDetector::RunReturn');
        expect(widgetCallers).not.toContain('CDetector::RunAssign');
      } finally {
        cg?.close();
      }
    });

    it('bridges a base virtual method to the subclass override', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
      fs.writeFileSync(
        path.join(tmpDir, 'iter.cpp'),
        'class Iterator {\n' +
        ' public:\n' +
        '  virtual void Next() { }\n' +
        '};\n' +
        'class DBIter : public Iterator {\n' +
        ' public:\n' +
        '  void Next() override { advance(); }\n' +
        '  void advance() { }\n' +
        '};\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      // Two methods named Next: the base virtual (lower line) and the override.
      const nexts = cg
        .getNodesByKind('method')
        .filter((n) => n.name === 'Next')
        .sort((a, b) => a.startLine - b.startLine);
      expect(nexts.length).toBe(2);
      const [baseNext, overrideNext] = nexts;

      // A vtable call to Iterator::Next dispatches to DBIter::Next — bridge it so
      // trace/callees from the interface method reaches the implementation.
      const edge = cg
        .getOutgoingEdges(baseNext!.id)
        .find((e) => e.target === overrideNext!.id && e.kind === 'calls');
      expect(edge, 'Iterator::Next should reach DBIter::Next via override synthesis').toBeDefined();

      cg.close();
    });
  });
}
