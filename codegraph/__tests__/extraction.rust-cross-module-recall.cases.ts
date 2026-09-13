import { CodeGraph } from '../src';
import { cleanupTempDir, createTempDir } from './extraction.fixtures';
import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerRustCrossModuleRecallTests(): void {


  describe('Rust cross-module recall', () => {
    function rustProject(files: Record<string, string>): string {
      const dir = createTempDir();
      fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "proj"\nversion = "0.1.0"\nedition = "2021"\n');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, 'src', rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      return dir;
    }

    it('extracts a struct literal `Foo { .. }` as an instantiation across modules', async () => {
      const dir = rustProject({
        'lib.rs': 'pub mod types;\npub mod consumer;\n',
        'types.rs': 'pub struct Widget { pub n: i32 }\n',
        'consumer.rs': 'use crate::types::Widget;\npub fn build() -> Widget { Widget { n: 1 } }\n',
      });
      try {
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('src/types.rs')).toContain('src/consumer.rs');
        cg.close();
      } finally { cleanupTempDir(dir); }
    });

    it('extracts trait method declarations and bridges trait dispatch to the impl', async () => {
      const dir = rustProject({
        'lib.rs': 'pub mod types;\npub mod consumer;\n',
        'types.rs': 'pub trait Render { fn render(&self) -> i32; }\n',
        // Mine implements Render structurally; reached via &dyn Render dispatch.
        'consumer.rs': 'use crate::types::Render;\npub struct Mine { pub x: i32 }\nimpl Render for Mine { fn render(&self) -> i32 { self.x } }\n',
      });
      try {
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        // implements edge (Mine -> Render) makes types.rs a dependent of consumer.rs's struct.
        expect(cg.getFileDependents('src/types.rs')).toContain('src/consumer.rs');
        cg.close();
      } finally { cleanupTempDir(dir); }
    });

    it('links `pub use` re-export hubs to the modules they re-export', async () => {
      const dir = rustProject({
        'lib.rs': 'pub mod api;\n',
        'api/mod.rs': 'mod widget;\npub use self::widget::Widget;\n',
        'api/widget.rs': 'pub struct Widget { pub n: i32 }\n',
      });
      try {
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        // The re-export hub depends on the module it re-exports from.
        expect(cg.getFileDependents('src/api/widget.rs')).toContain('src/api/mod.rs');
        cg.close();
      } finally { cleanupTempDir(dir); }
    });

    it('resolves a qualified path to the correct module when the leaf name collides', async () => {
      const dir = rustProject({
        'lib.rs': 'pub mod fast;\npub mod slow;\npub mod hub;\n',
        'fast.rs': 'pub fn read() -> i32 { 1 }\n',
        'slow.rs': 'pub fn read() -> i32 { 2 }\n',
        // `read` exists in BOTH fast.rs and slow.rs — module-path resolution must
        // send this re-export to fast.rs specifically, not name-match either.
        'hub.rs': 'pub use crate::fast::read;\n',
      });
      try {
        const cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        cg.resolveReferences();
        expect(cg.getFileDependents('src/fast.rs')).toContain('src/hub.rs');
        expect(cg.getFileDependents('src/slow.rs')).not.toContain('src/hub.rs');
        cg.close();
      } finally { cleanupTempDir(dir); }
    });
  });
}
