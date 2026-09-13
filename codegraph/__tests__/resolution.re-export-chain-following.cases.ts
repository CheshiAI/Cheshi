import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

export function registerReExportChainFollowingTests(scope: {
  tempDir: string;
  cg: CodeGraph;
}): void {


  describe('re-export chain following', () => {
    it('chases a 3-hop barrel chain (wildcard → named → declaration)', async () => {
      // main.ts → all.ts (wildcard) → index.ts (named) → auth.ts (declaration).
      // Without chain following, `signIn` resolves to nothing because
      // none of the barrel files declare it directly.
      fs.mkdirSync(path.join(scope.tempDir, 'src/services'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/services/auth.ts'),
        `export function signIn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/services/index.ts'),
        `export { signIn } from './auth';\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/all.ts'),
        /* language=TEXT */ `export * from './services/index';\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/main.ts'),
        `import { signIn } from './all';\nexport function go(): void { signIn(); }\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const signInNode = scope.cg
        .getNodesByKind('function')
        .find((n) => n.name === 'signIn' && n.filePath === 'src/services/auth.ts');
      expect(signInNode).toBeDefined();
      const callers = scope.cg.getCallers(signInNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    });

    it('follows a renamed named re-export (export { foo as bar } from ...)', async () => {
      // The chase has to look up `foo` in the upstream module even
      // though the importer asked for `bar` — exercises the rename
      // branch of findExportedSymbol.
      fs.mkdirSync(path.join(scope.tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/auth.ts'),
        `export function signIn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/index.ts'),
        `export { signIn as login } from './auth';\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/main.ts'),
        /* language=TEXT */ `import { login } from './index';\nexport function go(): void { login(); }\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const signInNode = scope.cg
        .getNodesByKind('function')
        .find((n) => n.name === 'signIn' && n.filePath === 'src/auth.ts');
      expect(signInNode).toBeDefined();
      const callers = scope.cg.getCallers(signInNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    });

    it('follows a default re-export of a .svelte component (export { default as Foo } from ./RealButton.svelte) (#629)', async () => {
      // The ubiquitous Svelte/React component-barrel form. The leaf is a
      // .svelte component (extracted as kind 'component', the default
      // export). The re-export ALIAS (`Foo`) deliberately differs from the
      // component's real name (`RealButton`) so the name-matcher fallback
      // can't coincidentally connect them — the only path to the edge is
      // the import-chase, which must match a `component` (not just
      // function/class) for the default export. Otherwise the
      // consumer↔component edge is never created and `callers` returns a
      // false 0.
      fs.mkdirSync(path.join(scope.tempDir, 'src/lib'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/lib/RealButton.svelte'),
        /* language=TEXT */ `<script lang="ts">\n  export let label: string = '';\n</script>\n\n<button>{label}</button>\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/lib/index.ts'),
        `export { default as Foo } from './RealButton.svelte';\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/Bar.svelte'),
        /* language=TEXT */ `<script lang="ts">\n  import { Foo } from './lib';\n</script>\n\n<Foo />\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const fooNode = scope.cg
        .getNodesByKind('component')
        .find((n) => n.name === 'RealButton' && n.filePath === 'src/lib/RealButton.svelte');
      expect(fooNode).toBeDefined();
      const callers = scope.cg.getCallers(fooNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/Bar.svelte')).toBe(true);
    });

    it('links an .astro page to the component and TS util it uses (#768)', async () => {
      // The canonical Astro shape: a page imports a layout/component in
      // frontmatter and uses it as a template tag; the component's template
      // calls an imported .ts util. Both hops must produce graph edges or
      // an Astro project is invisible to callers/impact.
      fs.mkdirSync(path.join(scope.tempDir, 'src/components'), { recursive: true });
      fs.mkdirSync(path.join(scope.tempDir, 'src/utils'), { recursive: true });
      fs.mkdirSync(path.join(scope.tempDir, 'src/pages'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/utils/format.ts'),
        `export function formatDate(d: Date): string { return d.toISOString(); }\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/components/PostCard.astro'),
        /* language=TEXT */ `---\nimport { formatDate } from '../utils/format';\nconst { date } = Astro.props;\n---\n<time>{formatDate(date)}</time>\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/pages/index.astro'),
        /* language=TEXT */ `---\nimport PostCard from '../components/PostCard.astro';\n---\n<PostCard date={new Date()} />\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      // Hop 1: page → component (template tag through the frontmatter import)
      const cardNode = scope.cg
        .getNodesByKind('component')
        .find((n) => n.name === 'PostCard' && n.filePath === 'src/components/PostCard.astro');
      expect(cardNode).toBeDefined();
      const cardCallers = scope.cg.getCallers(cardNode!.id);
      expect(cardCallers.some((c) => c.node.filePath === 'src/pages/index.astro')).toBe(true);

      // Hop 2: component template call → .ts util
      const fmtNode = scope.cg
        .getNodesByKind('function')
        .find((n) => n.name === 'formatDate' && n.filePath === 'src/utils/format.ts');
      expect(fmtNode).toBeDefined();
      const fmtCallers = scope.cg.getCallers(fmtNode!.id);
      expect(fmtCallers.some((c) => c.node.filePath === 'src/components/PostCard.astro')).toBe(true);
    });

    it('resolves a bare directory import (import { x } from "." / "./") to index.ts (#629)', async () => {
      // `import { helper } from '.'` (or './') must map to the
      // directory's index.ts before the re-export chase can run. The
      // barrel renames `realHelper` → `helper` so the name-matcher can't
      // mask a path-resolution failure: only the bare-dir resolution +
      // rename chase can connect the edge.
      fs.mkdirSync(path.join(scope.tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/util.ts'),
        `export function realHelper(): void {}\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/index.ts'),
        `export { realHelper as helper } from './util';\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/main.ts'),
        `import { helper } from '.';\nexport function go(): void { helper(); }\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/main2.ts'),
        `import { helper } from './';\nexport function go2(): void { helper(); }\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const helperNode = scope.cg
        .getNodesByKind('function')
        .find((n) => n.name === 'realHelper' && n.filePath === 'src/util.ts');
      expect(helperNode).toBeDefined();
      const callers = scope.cg.getCallers(helperNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
      expect(callers.some((c) => c.node.filePath === 'src/main2.ts')).toBe(true);
    });

    it('resolves a workspace package-subpath barrel (@scope/pkg/sub) to its index (#629)', async () => {
      // bun/npm/pnpm workspace: `@scope/ui/widgets` → the `ui` package's
      // `widgets/` subdir index, which re-exports a .svelte component.
      // Alias `Thing` ≠ component `Widget` defeats the name-matcher, so
      // only workspace-package resolution can connect the edge.
      fs.mkdirSync(path.join(scope.tempDir, 'packages/ui/widgets'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'package.json'),
        JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2)
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'packages/ui/package.json'),
        JSON.stringify({ name: '@scope/ui', version: '1.0.0' }, null, 2)
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'packages/ui/widgets/Widget.svelte'),
        /* language=TEXT */ `<script lang="ts">\n  export let label: string = '';\n</script>\n\n<button>{label}</button>\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'packages/ui/widgets/index.ts'),
        `export { default as Thing } from './Widget.svelte';\n`
      );
      fs.mkdirSync(path.join(scope.tempDir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'app/App.svelte'),
        /* language=TEXT */ `<script lang="ts">\n  import { Thing } from '@scope/ui/widgets';\n</script>\n\n<Thing />\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const buttonNode = scope.cg
        .getNodesByKind('component')
        .find((n) => n.name === 'Widget' && n.filePath === 'packages/ui/widgets/Widget.svelte');
      expect(buttonNode).toBeDefined();
      const callers = scope.cg.getCallers(buttonNode!.id);
      expect(callers.some((c) => c.node.filePath === 'app/App.svelte')).toBe(true);
    });

    it('resolves a barrel import from a Vue SFC script block (#629)', async () => {
      // The same import-resolution gaps (no SFC import mappings, no SFC
      // extension list, barrel parsed in the consumer's language) broke
      // Vue SFCs too. Guards the resolver-side generalization to `.vue`.
      // The barrel renames `realRun` → `run` so only the import-chase (not
      // the name-matcher) can connect the call.
      fs.mkdirSync(path.join(scope.tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/util.ts'),
        `export function realRun(): void {}\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/index.ts'),
        `export { realRun as run } from './util';\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/App.vue'),
        /* language=TEXT */ `<script lang="ts">\nimport { run } from './';\nexport default { mounted() { run(); } };\n</script>\n<template><div/></template>\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const runNode = scope.cg
        .getNodesByKind('function')
        .find((n) => n.name === 'realRun' && n.filePath === 'src/util.ts');
      expect(runNode).toBeDefined();
      const callers = scope.cg.getCallers(runNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/App.vue')).toBe(true);
    });

    it('follows a Vue component used in a <template> through a default re-export barrel (#629)', async () => {
      // End-to-end Vue analogue of the Svelte case: the leaf is a `.vue`
      // component re-exported under an alias (`Thing`) that differs from its
      // real name (`Widget`), and the consumer uses it ONLY in markup
      // (`<Thing />`). Requires both the new template-tag extraction AND the
      // barrel default-export chase to connect the edge.
      fs.mkdirSync(path.join(scope.tempDir, 'src/lib'), { recursive: true });
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/lib/Widget.vue'),
        /* language=TEXT */ `<script setup lang="ts">\ndefineProps<{ label?: string }>();\n</script>\n<template><button>x</button></template>\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/lib/index.ts'),
        `export { default as Thing } from './Widget.vue';\n`
      );
      fs.writeFileSync(
        path.join(scope.tempDir, 'src/App.vue'),
        /* language=TEXT */ `<script setup lang="ts">\nimport { Thing } from './lib';\n</script>\n<template>\n  <Thing />\n</template>\n`
      );

      scope.cg = await CodeGraph.init(scope.tempDir, { index: true });
      scope.cg.resolveReferences();

      const widgetNode = scope.cg
        .getNodesByKind('component')
        .find((n) => n.name === 'Widget' && n.filePath === 'src/lib/Widget.vue');
      expect(widgetNode).toBeDefined();
      const callers = scope.cg.getCallers(widgetNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/App.vue')).toBe(true);
    });
  });


  describe('Literal receivers and nested-local scope (#1230)', () => {
    // Two stacked fabrications: `", ".join(...)` (a builtin on a string
    // literal) exact-matched a project function named `join` — one that was
    // moreover nested inside a DIFFERENT function and thus lexically
    // unreachable. Literal receivers now emit no call ref at all, and
    // exact-match refuses candidates nested in a function the ref isn't in.
    it("str-literal builtin calls don't bind to project symbols; nested locals only resolve from inside their container", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1230-'));
      try {
        fs.writeFileSync(
          path.join(tmpDir, 'repro.py'),
          `def format_fields(values):
    def join(vals):
        return "-".join(sorted(vals))

    return join(values)


def report_missing(unresolved):
    missing_list = ", ".join(sorted(unresolved))
    return f"Could not resolve: {missing_list}"
`
        );

        const cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        const join = cg.searchNodes('join', { limit: 5 }).find(
          (r) => r.node.kind === 'function' && r.node.name === 'join'
        );
        expect(join).toBeDefined();

        // Exactly one caller: the enclosing format_fields. Neither
        // report_missing (literal receiver) nor join itself (its own literal
        // "-".join) may appear.
        const callers = cg.getCallers(join!.node.id);
        expect(callers.map((c) => c.node.name)).toEqual(['format_fields']);

        // report_missing has zero project callees.
        const reportMissing = cg.searchNodes('report_missing', { limit: 5 }).find(
          (r) => r.node.kind === 'function'
        );
        const callees = cg.getCallees(reportMissing!.node.id);
        expect(callees.filter((c) => c.node.name === 'join')).toHaveLength(0);
        cg.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 30000);
  });


  describe('Go field-chain receiver calls (#1276)', () => {
    // `target.conn.Exec(...)` where `conn *sql.DB` used to emit a BARE `Exec`
    // ref, which exact-matched the only local `Exec` — an unrelated
    // interface's method — fabricating an internal dependency. Chained Go
    // receivers now resolve exclusively via validated field-hop inference:
    // external field types produce NO edge; in-project ones produce the
    // correct edge (new recall).
    it('external receiver types produce no edge; in-project field chains resolve correctly', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1276-'));
      try {
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
        fs.mkdirSync(path.join(tmpDir, 'flow'));
        fs.writeFileSync(
          path.join(tmpDir, 'flow', 'flow.go'),
          `package flow

import "database/sql"

type InternalStore interface {
	Exec(string, ...any) (sql.Result, error)
	QueryRow(string, ...any) *sql.Row
}

type Target struct{ conn *sql.DB }

func (target *Target) Write() error {
	_, err := target.conn.Exec("insert")
	return err
}

func (target *Target) Read() *sql.Row {
	return target.conn.QueryRow("select")
}

type Store struct{}

func (s *Store) Put(key string) {}

type Repo struct{ db *Store }

func (r *Repo) Save() {
	r.db.Put("k")
}
`
        );

        const cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        // The unrelated local interface's methods have NO callers — the
        // external sql.DB calls must not bind to them.
        const execDecl = cg.searchNodes('Exec', { limit: 10 }).find(
          (r) => r.node.kind === 'method'
        );
        if (execDecl) {
          const execCallers = cg.getCallers(execDecl.node.id);
          expect(execCallers.map((c) => c.node.name)).not.toContain('Write');
        }
        const qrDecl = cg.searchNodes('QueryRow', { limit: 10 }).find(
          (r) => r.node.kind === 'method'
        );
        if (qrDecl) {
          const qrCallers = cg.getCallers(qrDecl.node.id);
          expect(qrCallers.map((c) => c.node.name)).not.toContain('Read');
        }

        // The in-project field chain resolves (validated), gaining an edge the
        // bare-name era never produced.
        const put = cg.searchNodes('Put', { limit: 10 }).find(
          (r) => r.node.kind === 'method' && r.node.qualifiedName?.includes('Store')
        );
        expect(put).toBeDefined();
        const putCallers = cg.getCallers(put!.node.id);
        expect(putCallers.map((c) => c.node.name)).toContain('Save');
        cg.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 30000);

    it('unexported field types resolve; stdlib-qualified types never bind a same-named local decoy', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1276b-'));
      try {
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/b\n\ngo 1.22\n');
        fs.writeFileSync(
          path.join(tmpDir, 'm.go'),
          `package m

import "net/http"

type node struct{}

func (n *node) InsertRoute(path string) {}

// A local type sharing the stdlib interface's name — the decoy the
// package-qualifier gate exists for.
type Handler func()

func (h Handler) ServeHTTP() {}

type Mux struct {
	// the tree router lives below this comment (the comment must not
	// donate a field type)
	handler http.Handler
	tree    *node
}

func (mx *Mux) handle(path string) {
	mx.tree.InsertRoute(path)
}

func (mx *Mux) dispatch() {
	mx.handler.ServeHTTP(nil, nil)
}
`
        );

        const cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        // Unexported in-package field type: chain resolves (chi's mx.tree shape),
        // and the doc comment above the field donates nothing.
        const insert = cg.searchNodes('InsertRoute', { limit: 5 }).find(
          (r) => r.node.kind === 'method'
        );
        expect(insert).toBeDefined();
        const insertCallers = cg.getCallers(insert!.node.id);
        expect(insertCallers.map((c) => c.node.name)).toContain('handle');

        // `handler http.Handler` is stdlib — the call must NOT bind to the
        // local decoy `Handler.ServeHTTP`.
        const serve = cg.searchNodes('ServeHTTP', { limit: 5 }).find(
          (r) => r.node.kind === 'method'
        );
        if (serve) {
          const serveCallers = cg.getCallers(serve.node.id);
          expect(serveCallers.map((c) => c.node.name)).not.toContain('dispatch');
        }
        cg.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 30000);
  });


  describe('Imported singleton instance-method calls (#1292)', () => {
    // `reproStore.notifyJoinGuildStatus()` after `import { reproStore }` used
    // to emit its calls edge to the CONSTANT (resolvedBy:'import'), while the
    // identical call in the defining file resolved to the method — so callers
    // of the method missed every cross-file use. The import path now infers
    // the value's type from its own declaration and resolves the member on it.
    it('cross-file call through an imported singleton resolves to the class method', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1292-'));
      try {
        fs.mkdirSync(path.join(tmpDir, 'src'));
        fs.writeFileSync(
          path.join(tmpDir, 'src', 'store.ts'),
          `export class ReproStore {
  notifyJoinGuildStatus(): void {
    console.log('notified');
  }
}

export const reproStore = new ReproStore();

export function callInDefinitionFile(): void {
  reproStore.notifyJoinGuildStatus();
}
`
        );
        fs.writeFileSync(
          path.join(tmpDir, 'src', 'caller.ts'),
          `import { reproStore } from './store';

export function callFromImportedFile(): void {
  reproStore.notifyJoinGuildStatus();
}
`
        );

        const cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        const method = cg.searchNodes('notifyJoinGuildStatus', { limit: 5 }).find(
          (r) => r.node.kind === 'method'
        );
        expect(method).toBeDefined();

        // BOTH functions call the method — the cross-file one included.
        const callers = cg.getCallers(method!.node.id);
        const callerNames = callers.map((c) => c.node.name).sort();
        expect(callerNames).toContain('callInDefinitionFile');
        expect(callerNames).toContain('callFromImportedFile');
        cg.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 30000);
  });

}
