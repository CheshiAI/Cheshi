import { CodeGraph } from '../src';
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function registerFlaskEndToEndFrameworkExtractionTests(): void {


  describe('Flask end-to-end framework extraction', () => {
    let tmpDir: string | undefined;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    it('resolves stacked routes across @login_required to a view named after a builtin (index)', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flask-'));
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0\n');
      fs.writeFileSync(
        path.join(tmpDir, 'app.py'),
        'from flask import Blueprint, render_template\n' +
        'from flask_login import login_required\n' +
        'bp = Blueprint("main", __name__)\n' +
        '\n' +
        '@bp.route("/", methods=["GET", "POST"])\n' +
        '@bp.route("/index", methods=["GET", "POST"])\n' +
        '@login_required\n' +
        'def index():\n' +
        '    return render_template("index.html")\n'
      );

      const cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      // Both stacked @bp.route decorators are extracted (the second was previously
      // dropped because @login_required broke the "def must follow" assumption).
      const routes = cg.getNodesByKind('route');
      expect(routes.map((r) => r.name).sort()).toEqual(['GET /', 'GET /index']);

      // The view function exists even though its name is a Python builtin method.
      const fn = cg.getNodesByKind('function').find((n) => n.name === 'index');
      expect(fn).toBeDefined();

      // Both routes resolve to it — exercises the bare-name builtin guard, which
      // previously filtered the `index` reference as a builtin method.
      for (const route of routes) {
        const edges = cg.getOutgoingEdges(route.id);
        const toView = edges.find((e) => e.target === fn!.id && e.kind === 'references');
        expect(toView, `route ${route.name} should resolve to index()`).toBeDefined();
      }

      cg.close();
    });
  });
}
