import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerRustModulePathCallResolutionTests(): void {


  describe('Rust module-path call resolution', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('a bare submodule call (`users::router()`) resolves self-relative to the submodule fn', async () => {
      // The canonical Axum router-assembly pattern: a parent module calls each
      // submodule's `router()`. `users::` / `profiles::` are SELF-relative
      // submodule prefixes (2018 edition) — `mod users;` makes `users` a child of
      // the CURRENT module, NOT `crate::users`. Before the fix the bare prefix was
      // resolved crate-relative only (looking for `src/users.rs`), so it found
      // nothing and the handler modules looked dependent-less.
      const http = path.join(tempDir, 'src/http');
      fs.mkdirSync(http, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/lib.rs'), `pub mod http;\n`);
      fs.writeFileSync(
        path.join(http, 'mod.rs'),
        `mod users;\nmod profiles;\npub fn api_router() {\n    users::router();\n    profiles::router();\n}\n`
      );
      fs.writeFileSync(path.join(http, 'users.rs'), `pub fn router() -> i32 { 1 }\n`);
      fs.writeFileSync(path.join(http, 'profiles.rs'), `pub fn router() -> i32 { 2 }\n`);

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      // Each submodule's same-named `router` fn must get mod.rs as a dependent —
      // proving the bare prefix resolved self-relative AND disambiguated the
      // colliding `router` name to the correct file (not an arbitrary one).
      const routers = cg.getNodesByKind('function').filter((n) => n.name === 'router');
      const usersRouter = routers.find((n) => n.filePath.endsWith('http/users.rs'));
      const profilesRouter = routers.find((n) => n.filePath.endsWith('http/profiles.rs'));
      expect(usersRouter, 'users.rs router fn').toBeDefined();
      expect(profilesRouter, 'profiles.rs router fn').toBeDefined();
      const usersDeps = [...cg.getImpactRadius(usersRouter!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      const profilesDeps = [...cg.getImpactRadius(profilesRouter!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(usersDeps.some((p) => p.endsWith('http/mod.rs')), 'users::router() lands on users.rs').toBe(true);
      expect(profilesDeps.some((p) => p.endsWith('http/mod.rs')), 'profiles::router() lands on profiles.rs').toBe(true);
    });

    it('a 3-segment module-path call (`database::profiles::find()`) resolves to the leaf fn', async () => {
      // A 2-level module path — the common `db.run(move |c| database::profiles::find(c))`
      // / `crate::a::b::func()` shape. The reference-resolver pre-filter used to drop any
      // `a::b::c` whose leaf it never checked (it tested only the first segment and the
      // `b::c` remainder, neither of which names a symbol), so the call never reached the
      // Rust path resolver and the leaf module looked dependent-less.
      const routes = path.join(tempDir, 'src/routes');
      const database = path.join(tempDir, 'src/database');
      fs.mkdirSync(routes, { recursive: true });
      fs.mkdirSync(database, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/lib.rs'), `pub mod routes;\npub mod database;\n`);
      fs.writeFileSync(path.join(database, 'mod.rs'), `pub mod profiles;\n`);
      fs.writeFileSync(path.join(database, 'profiles.rs'), `pub fn find(id: i32) -> i32 { id }\n`);
      fs.writeFileSync(
        path.join(routes, 'mod.rs'),
        `use crate::database;\npub fn get_profile(id: i32) -> i32 {\n    database::profiles::find(id)\n}\n`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const find = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'find' && n.filePath.endsWith('database/profiles.rs'));
      expect(find, 'database/profiles.rs find fn').toBeDefined();
      const deps = [...cg.getImpactRadius(find!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('routes/mod.rs')), 'database::profiles::find() resolves to the leaf fn').toBe(true);
    });

    it('Rocket `routes![…]` / `catchers![…]` macros link the mount to the handler fns', async () => {
      // Tree-sitter leaves the macro body as a raw token tree, so the handler
      // paths inside `routes![a::b::handler, …]` are invisible to the call walker
      // and the handlers — mounted by Rocket at runtime, not called in-repo — look
      // like they have no caller. The route-macro extractor reconstructs each path
      // and emits a reference, which the Rust path resolver links to the handler.
      const routes = path.join(tempDir, 'src/routes');
      fs.mkdirSync(routes, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/lib.rs'),
        `mod routes;\nfn not_found() {}\npub fn rocket() {\n` +
        `    rocket::build()\n` +
        `        .mount("/api", routes![routes::users::post_users, routes::users::get_user])\n` +
        `        .register("/", catchers![not_found]);\n}\n`);
      fs.writeFileSync(path.join(routes, 'mod.rs'), `pub mod users;\n`);
      fs.writeFileSync(path.join(routes, 'users.rs'), `pub fn post_users() {}\npub fn get_user() {}\n`);

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const handlers = cg.getNodesByKind('function').filter((n) => n.filePath.endsWith('routes/users.rs'));
      expect(handlers.length, 'both handler fns indexed').toBe(2);
      for (const h of handlers) {
        const deps = [...cg.getImpactRadius(h.id, 2).nodes.values()].map((n) => n.filePath ?? '');
        expect(deps.some((p) => p.endsWith('lib.rs')), `routes![] links ${h.name} to its mount in lib.rs`).toBe(true);
      }
    });
  });
}
