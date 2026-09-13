import { CodeGraph } from '../src';
import { cleanupGraphTest, createTempDir } from './extraction.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerLuaLuauRequireResolutionTests(): void {


  describe('Lua/Luau require resolution', () => {
    //noinspection DuplicatedCode
    let tempDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      tempDir = createTempDir();
    });

    afterEach(() => cleanupGraphTest(cg, tempDir));

    it('resolves a dotted Lua require and an instance-path Luau require to their module files', async () => {
      // The require is the ONLY link (no method call), so coverage here proves the
      // require resolver specifically, not method-call name-matching.
      // Lua dotted module path: require("myapp.config") → lua/myapp/config.lua.
      fs.mkdirSync(path.join(tempDir, 'lua/myapp'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'lua/myapp/config.lua'), `local M = {}\nfunction M.setup() end\nreturn M\n`);
      fs.writeFileSync(path.join(tempDir, 'lua/myapp/init.lua'), `local config = require("myapp.config")\nreturn config\n`);
      // Luau Roblox instance-path require (only the leaf survives extraction):
      // require(script.Util.helper) → src/Util/helper.luau.
      fs.mkdirSync(path.join(tempDir, 'src/Util'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/Util/helper.luau'), `local H = {}\nfunction H.go() end\nreturn H\n`);
      fs.writeFileSync(path.join(tempDir, 'src/init.luau'), `local helper = require(script.Util.helper)\nreturn helper\n`);

      cg = CodeGraph.initSync(tempDir);
      await cg.indexAll();
      cg.resolveReferences();

      const config = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('myapp/config.lua'));
      const helper = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('Util/helper.luau'));
      expect(config, 'config.lua file node').toBeDefined();
      expect(helper, 'helper.luau file node').toBeDefined();
      const cfgDeps = cg.getFileDependents(config!.filePath);
      const helpDeps = cg.getFileDependents(helper!.filePath);
      expect(cfgDeps.some((p) => p.endsWith('myapp/init.lua')), 'dotted Lua require resolves to the module').toBe(true);
      expect(helpDeps.some((p) => p.endsWith('src/init.luau')), 'instance-path Luau require resolves to the module').toBe(true);
    });
  });
}
