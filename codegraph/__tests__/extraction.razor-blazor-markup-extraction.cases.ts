import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerRazorBlazorMarkupExtractionTests(): void {


  describe('Razor / Blazor markup extraction', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links @model and Blazor component tags to their C# types; ignores HTML elements', async () => {
      fs.mkdirSync(path.join(tempDir, 'Views'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'LoginViewModel.cs'),
        `namespace App { public class LoginViewModel { public string Email { get; set; } } }`
      );
      fs.writeFileSync(
        path.join(tempDir, 'ToastComponent.cs'),
        `namespace App { public class ToastComponent { } }`
      );
      fs.writeFileSync(
        path.join(tempDir, 'Views/Login.cshtml'),
      /* language=TEXT */ `@model LoginViewModel\n<div class="form">\n  <input asp-for="Email" />\n</div>\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'Index.razor'),
      /* language=TEXT */ `<div>\n  <ToastComponent />\n</div>\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      // `@model LoginViewModel` → the view-model class.
      const vm = cg.getNodesByKind('class').find((n) => n.name === 'LoginViewModel');
      expect(vm, 'LoginViewModel class').toBeDefined();
      const vmDeps = [...cg.getImpactRadius(vm!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(vmDeps.some((p) => p.endsWith('Login.cshtml')), '@model links the view').toBe(true);

      // `<ToastComponent />` → the component class.
      const toast = cg.getNodesByKind('class').find((n) => n.name === 'ToastComponent');
      expect(toast, 'ToastComponent class').toBeDefined();
      const toastDeps = [...cg.getImpactRadius(toast!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(toastDeps.some((p) => p.endsWith('Index.razor')), 'Blazor tag links the component').toBe(true);

      // HTML elements (`<div>`, `<input>`) must NOT become component references.
      const htmlNodes = cg.getNodesByKind('class').filter((n) => n.name === 'div' || n.name === 'input');
      expect(htmlNodes.length, 'no node for HTML elements').toBe(0);
    });

    it('C# namespaces qualify type names so same-named types are distinct', async () => {
      fs.writeFileSync(path.join(tempDir, 'entity.cs'), `namespace App.Entities { public class CatalogBrand { } }`);
      fs.writeFileSync(path.join(tempDir, 'dto.cs'), `namespace App.Models { public class CatalogBrand { } }`);

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();

      const brands = cg.getNodesByKind('class').filter((n) => n.name === 'CatalogBrand');
      expect(brands.length, 'both CatalogBrand classes indexed').toBe(2);
      const qns = brands.map((b) => b.qualifiedName).sort();
      expect(qns[0]).not.toBe(qns[1]); // distinct qualified names (namespace-scoped)
      expect(qns.some((q) => q.includes('Entities') && q.endsWith('CatalogBrand'))).toBe(true);
      expect(qns.some((q) => q.includes('Models') && q.endsWith('CatalogBrand'))).toBe(true);
    });

    it('disambiguates a Razor type ref via @using (incl. folder _Imports.razor)', async () => {
      // `CatalogBrand` exists as both a domain entity and a DTO; the component
      // `@using`s the DTO's namespace (here via the folder _Imports.razor), so the
      // ref must resolve to the DTO, not the same-named entity.
      fs.mkdirSync(path.join(tempDir, 'Models'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'Entities'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'Pages'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'Models/CatalogBrand.cs'), `namespace App.Models { public class CatalogBrand { public int Id { get; set; } } }`);
      fs.writeFileSync(path.join(tempDir, 'Entities/CatalogBrand.cs'), `namespace App.Entities { public class CatalogBrand { public int Id { get; set; } } }`);
      fs.writeFileSync(path.join(tempDir, 'Pages/_Imports.razor'), /* language=TEXT */ `@using App.Models\n`);
      fs.writeFileSync(
        path.join(tempDir, 'Pages/List.razor'),
      /* language=TEXT */ `<h1>List</h1>\n@code {\n  private CatalogBrand _b = new CatalogBrand();\n}\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const dto = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'App.Models::CatalogBrand');
      const entity = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'App.Entities::CatalogBrand');
      expect(dto && entity, 'both CatalogBrand classes').toBeTruthy();
      const dtoDeps = [...cg.getImpactRadius(dto!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      const entityDeps = [...cg.getImpactRadius(entity!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(dtoDeps.some((p) => p.endsWith('List.razor')), 'resolves to the @using\'d DTO').toBe(true);
      expect(entityDeps.some((p) => p.endsWith('List.razor')), 'NOT the same-named entity').toBe(false);
    });

    it('delegates Blazor @code block C# to cover types used in component logic', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'CatalogService.cs'),
        `namespace App { public class CatalogService { public void Load() { } } }`
      );
      fs.writeFileSync(
        path.join(tempDir, 'List.razor'),
      /* language=TEXT */ `<h1>Catalog</h1>\n\n@code {\n  private CatalogService _svc = new CatalogService();\n  void Refresh() { _svc.Load(); }\n}\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const svc = cg.getNodesByKind('class').find((n) => n.name === 'CatalogService');
      expect(svc, 'CatalogService class').toBeDefined();
      const deps = [...cg.getImpactRadius(svc!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('List.razor')), '@code usage links the component to the service').toBe(true);
    });
  });
}
