import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerPythonAbsoluteModuleImportResolutionTests(): void {


  describe('Python absolute module import resolution', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links a bare `import pkg.module` of an internal module to its file', async () => {
      // `import conduit.apps.signals` (a Django-style side-effect import, and any
      // dotted absolute module import) had no edge to the module file — only
      // `from x import y` was linked — so a module imported by its dotted path
      // looked like nothing depended on it.
      fs.mkdirSync(path.join(tempDir, 'conduit/apps'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'conduit/__init__.py'), '');
      fs.writeFileSync(path.join(tempDir, 'conduit/apps/__init__.py'), '');
      fs.writeFileSync(path.join(tempDir, 'conduit/apps/signals.py'), `def handler():\n    pass\n`);
      fs.writeFileSync(
        path.join(tempDir, 'conduit/apps/app.py'),
        `import conduit.apps.signals\nimport os\n\nVALUE = 1\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const signals = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('conduit/apps/signals.py'));
      expect(signals, 'signals.py indexed').toBeDefined();
      const deps = [...cg.getImpactRadius(signals!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('app.py')), 'importer depends on the module').toBe(true);
      // `import os` (stdlib) must NOT fabricate an edge — no os.py file in the repo.
      const osNode = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('/os.py'));
      expect(osNode, 'no stdlib os.py node').toBeUndefined();
    });

    it('Django include() links the root URLconf to the included app urls module', async () => {
      // `url(r'^api/', include('app.urls'))` should record a dependency from the
      // root urlconf onto the included app's `urls.py` — so editing an app's routes
      // surfaces the project urlconf that mounts them.
      fs.mkdirSync(path.join(tempDir, 'app'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'requirements.txt'), `django==4.0\n`);
      fs.writeFileSync(path.join(tempDir, 'app/__init__.py'), '');
      fs.writeFileSync(path.join(tempDir, 'app/views.py'), `def home(request):\n    return None\n`);
      fs.writeFileSync(
        path.join(tempDir, 'app/urls.py'),
        `from django.conf.urls import url\nfrom . import views\nurlpatterns = [url(r'^$', views.home)]\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'urls.py'),
        `from django.conf.urls import include, url\nurlpatterns = [url(r'^app/', include('app.urls'))]\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const appUrls = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('app/urls.py'));
      expect(appUrls, 'app/urls.py indexed').toBeDefined();
      const deps = [...cg.getImpactRadius(appUrls!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('urls.py') && !p.endsWith('app/urls.py')), 'root urlconf depends on the included app urls').toBe(true);
    });

    it('resolves `from pkg import submodule` to the submodule under that package, not a same-named one', async () => {
      // FastAPI router-aggregator pattern: `from app.api.routes import authentication`
      // with same-named modules in sibling packages must resolve via the import's
      // SOURCE (the package), not a coincidental same-basename file elsewhere.
      fs.mkdirSync(path.join(tempDir, 'app/api/routes'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'app/api/dependencies'), { recursive: true });
      for (const p of ['app/__init__.py', 'app/api/__init__.py', 'app/api/routes/__init__.py', 'app/api/dependencies/__init__.py']) {
        fs.writeFileSync(path.join(tempDir, p), '');
      }
      fs.writeFileSync(path.join(tempDir, 'app/api/routes/authentication.py'), `def login():\n    pass\n`);
      fs.writeFileSync(path.join(tempDir, 'app/api/dependencies/authentication.py'), `def get_user():\n    pass\n`);
      fs.writeFileSync(
        path.join(tempDir, 'app/api/routes/api.py'),
        `from app.api.routes import authentication\n\nROUTER = authentication\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const routesAuth = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('routes/authentication.py'));
      const depsAuth = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('dependencies/authentication.py'));
      expect(routesAuth && depsAuth).toBeTruthy();
      const routesDeps = [...cg.getImpactRadius(routesAuth!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      const depsDeps = [...cg.getImpactRadius(depsAuth!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(routesDeps.some((p) => p.endsWith('routes/api.py')), 'submodule under the imported package is the dependent').toBe(true);
      expect(depsDeps.some((p) => p.endsWith('routes/api.py')), 'same-named module in a sibling package is NOT').toBe(false);
    });
  });
}
