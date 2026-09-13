import { ALL_TARGETS } from '../src/installer/targets/registry';
import { listAllFiles, mkTmpDir, setHome } from './installer-targets.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerInstallerTargetsContractTests(): void {


  describe('Installer targets — contract', () => {
    //noinspection DuplicatedCode
    let tmpHome: string;
    let tmpCwd: string;
    let origCwd: string;
    let homeRestore: { restore: () => void };

    beforeEach(() => {
      tmpHome = mkTmpDir('home');
      tmpCwd = mkTmpDir('cwd');
      origCwd = process.cwd();
      process.chdir(tmpCwd);
      homeRestore = setHome(tmpHome);
    });

    afterEach(() => {
      homeRestore.restore();
      process.chdir(origCwd);
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    });

    for (const target of ALL_TARGETS) {
      describe(target.id, () => {
        const supportedLocations = (['global', 'local'] as const).filter((l) =>
          target.supportsLocation(l),
        );

        for (const location of supportedLocations) {
          describe(`location=${location}`, () => {
            it('install writes files; detect.alreadyConfigured becomes true', () => {
              expect(target.detect(location).alreadyConfigured).toBe(false);

              const result = target.install(location, { autoAllow: true });
              expect(result.files.length).toBeGreaterThan(0);
              for (const file of result.files) {
                if (file.action !== 'unchanged') {
                  expect(fs.existsSync(file.path)).toBe(true);
                }
              }

              expect(target.detect(location).alreadyConfigured).toBe(true);
            });

            it('re-running install is idempotent (no actions other than unchanged)', () => {
              target.install(location, { autoAllow: true });
              const second = target.install(location, { autoAllow: true });
              for (const file of second.files) {
                expect(file.action).toBe('unchanged');
              }
            });

            it('install preserves a pre-existing sibling MCP server (where applicable)', () => {
              // Plant a sibling entry in the same JSON config, install,
              // and verify the sibling survives. Skip for Codex (TOML)
              // and any target with no JSON config — they get covered
              // by their own dedicated tests below.
              const paths = target.describePaths(location);
              // Match .json or .jsonc — opencode prefers .jsonc.
              const jsonPath = paths.find((p) => /\.jsonc?$/.test(p));
              if (!jsonPath) return;

              // Seed pre-existing config.
              fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
              const seed: Record<string, any> = { mcpServers: { other: { command: 'x' } } };
              // opencode uses `mcp` not `mcpServers`. Match its shape too.
              if (target.id === 'opencode') {
                delete seed.mcpServers;
                seed.mcp = { other: { type: 'local', command: ['x'], enabled: true } };
              }
              fs.writeFileSync(jsonPath, JSON.stringify(seed, null, 2) + '\n');

              target.install(location, { autoAllow: true });

              const after = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
              if (target.id === 'opencode') {
                expect(after.mcp.other).toBeDefined();
                expect(after.mcp.codegraph).toBeDefined();
              } else {
                expect(after.mcpServers.other).toBeDefined();
                expect(after.mcpServers.codegraph).toBeDefined();
              }
            });

            it('uninstall reverses install (alreadyConfigured returns to false)', () => {
              target.install(location, { autoAllow: true });
              expect(target.detect(location).alreadyConfigured).toBe(true);

              target.uninstall(location);
              expect(target.detect(location).alreadyConfigured).toBe(false);
            });

            it('printConfig returns non-empty output without writing anything', () => {
              const before = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
              const out = target.printConfig(location);
              expect(out.length).toBeGreaterThan(0);
              const after = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
              expect(after.sort()).toEqual(before.sort());
            });
          });
        }
      });
    }
  });
}
