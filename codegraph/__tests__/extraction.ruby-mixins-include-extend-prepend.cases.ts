import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerRubyMixinsIncludeExtendPrependTests(): void {


  describe('Ruby mixins (include/extend/prepend)', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('links include/extend/prepend to the mixed-in module across files', async () => {
      const lib = path.join(tempDir, 'lib');
      fs.mkdirSync(lib, { recursive: true });

      fs.writeFileSync(
        path.join(lib, 'concerns.rb'),
        `module Trackable
  def track; end
end

module Cacheable
  def cache; end
end

module Loggable
  def log; end
end
`
      );
      fs.writeFileSync(
        path.join(lib, 'model.rb'),
        `class Model
  include Trackable
  prepend Cacheable
  extend Loggable
end
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const model = cg.getNodesByKind('class').find((n) => n.name === 'Model');
      expect(model).toBeDefined();

      // All three mixin forms create an `implements` edge Model → module, so
      // editing a concern surfaces every class that mixes it in (across files).
      for (const moduleName of ['Trackable', 'Cacheable', 'Loggable']) {
        const mod = cg.getNodesByKind('module').find((n) => n.name === moduleName);
        expect(mod, moduleName).toBeDefined();
        const impacted = [...cg.getImpactRadius(mod!.id, 3).nodes.values()].map((n) => n.name);
        expect(impacted, `${moduleName} should be depended on by Model`).toContain('Model');
      }
    });

    it('resolves require / require_relative to the required file', async () => {
      const lib = path.join(tempDir, 'lib');
      fs.mkdirSync(path.join(lib, 'app'), { recursive: true });

      // A leaf file whose class is referenced only dynamically — so without
      // require resolution it would look like nothing depends on it.
      fs.writeFileSync(
        path.join(lib, 'app', 'fetcher.rb'),
        `module App
  class Fetcher
    def fetch; end
  end
end
`
      );
      // Pulled in by a load-path `require` …
      fs.writeFileSync(
        path.join(lib, 'app', 'worker.rb'),
        `require "app/fetcher"

module App
  class Worker; end
end
`
      );
      // … and a sibling pulled in by `require_relative`.
      fs.writeFileSync(
        path.join(lib, 'app', 'boot.rb'),
        `require_relative "fetcher"
`
      );

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      // The require edges target fetcher.rb's FILE node. Editing it should reach
      // BOTH the load-path requirer (worker.rb) and the require_relative one
      // (boot.rb) — without require resolution its file would have no dependents.
      const fetcher = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('app/fetcher.rb'));
      expect(fetcher, 'fetcher.rb indexed').toBeDefined();
      const reached = [...cg.getImpactRadius(fetcher!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(reached.some((p) => p.endsWith('app/worker.rb'))).toBe(true);
      expect(reached.some((p) => p.endsWith('app/boot.rb'))).toBe(true);
    });
  });
}
