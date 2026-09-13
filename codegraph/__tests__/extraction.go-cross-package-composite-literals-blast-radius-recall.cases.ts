import { CodeGraph } from '../src';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerGoCrossPackageCompositeLiteralsBlastRadiusRecallTests(): void {


  describe('Go cross-package composite literals (blast-radius recall)', () => {
    // Go function calls and type references across packages already resolved, but
    // struct composite literals — `render.XML{...}` / `pkga.Widget{...}` — were not
    // extracted at all, so a package whose types are only INSTANTIATED elsewhere
    // (gin's render/binding implementations) showed 0 dependents.
    it('links a cross-package struct composite literal to the defining package', async () => {
      const dir = createTempDir();
      try {
        fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
        fs.mkdirSync(path.join(dir, 'render'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'render', 'xml.go'), `package render\n\ntype XML struct { Data any }\n`);
        fs.writeFileSync(path.join(dir, 'app.go'), `package main\n\nimport "example.com/proj/render"\n\nfunc handle() any { return render.XML{} }\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('render/xml.go')).toContain('app.go');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });

    it('links a composite literal in a package-level var registry', async () => {
      const dir = createTempDir();
      try {
        fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
        fs.mkdirSync(path.join(dir, 'render'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'render', 'xml.go'), `package render\n\ntype XML struct {}\nfunc (XML) Render() {}\n`);
        // The implementation is registered only in a top-level `var registry = {...}`
        // map literal — the body walker doesn't cover top-level declarations, so this
        // exercises the var-initializer walking added for Go.
        fs.writeFileSync(path.join(dir, 'reg.go'), `package main\n\nimport "example.com/proj/render"\n\ntype R interface { Render() }\n\nvar registry = map[string]R{ "xml": render.XML{} }\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('render/xml.go')).toContain('reg.go');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });

    it('attributes a call inside a top-level closure (cobra RunE) to the var, not the file (#693)', async () => {
      const dir = createTempDir();
      try {
        fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
        // Wire is called ONLY from the anonymous RunE closure inside a top-level
        // `var rootCmd = &Cmd{...}` — previously the call leaked to the file node,
        // so `callers(Wire)` surfaced a file (or read as "no caller"). It must now
        // attribute to the enclosing var.
        fs.writeFileSync(path.join(dir, 'factory.go'), `package main\n\nfunc Wire() error { return nil }\n`);
        fs.writeFileSync(
          path.join(dir, 'root.go'),
          `package main\n\ntype Cmd struct{ RunE func() error }\n\nvar rootCmd = &Cmd{\n\tRunE: func() error { return Wire() },\n}\n`
        );
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();

        const wire = cg.getNodesByName('Wire').find((n) => n.kind === 'function');
        expect(wire).toBeDefined();
        const callers = cg.getCallers(wire!.id).map((c) => c.node);
        expect(callers.some((n) => n.kind === 'variable' && n.name === 'rootCmd')).toBe(true);
        expect(callers.some((n) => n.kind === 'file')).toBe(false);
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });

    it('links a parenthesized pointer type conversion `(*T)(x)` to the type', async () => {
      const dir = createTempDir();
      try {
        fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
        fs.writeFileSync(path.join(dir, 'types.go'), `package main\n\ntype Wrapped struct { N int }\n`);
        // `(*Wrapped)(x)` parses as a call whose callee is the parenthesized type
        // `(*Wrapped)` — without normalization it dropped on the floor.
        fs.writeFileSync(path.join(dir, 'use.go'), `package main\n\nfunc run(x *int) { _ = (*Wrapped)(x) }\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('types.go')).toContain('use.go');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });

    it('links an implementation reached only through a Go interface (implicit satisfaction, #584)', async () => {
      const dir = createTempDir();
      try {
        fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
        fs.mkdirSync(path.join(dir, 'codec'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'codec', 'api.go'), `package codec\n\ntype Core interface {\n\tMarshal(v any) ([]byte, error)\n}\n\nvar API Core\n`);
        // jsonApi satisfies Core structurally (no `implements` keyword) and is
        // reached ONLY through the interface (API.Marshal). Without implicit
        // interface satisfaction + dispatch, json.go shows 0 dependents.
        fs.writeFileSync(path.join(dir, 'codec', 'json.go'), `package codec\n\ntype jsonApi struct{}\n\nfunc (j jsonApi) Marshal(v any) ([]byte, error) { return nil, nil }\n\nfunc init() { API = jsonApi{} }\n`);
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('codec/json.go')).toContain('codec/api.go');
        cg.close();
      } finally {
        cleanupTempDir(dir);
      }
    });
  });
}
