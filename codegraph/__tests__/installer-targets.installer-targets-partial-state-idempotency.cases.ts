import {
  cleanupLegacyHooks,
  removePromptHookEntry,
  writePromptHookEntry,
} from '../src/installer/targets/claude';
import { getTarget } from '../src/installer/targets/registry';
import {
  registerCodexInstallWritesConfigTomlAndTheAgentsMdCodegraphBlock704Tests,
} from './installer-targets.codex-install-writes-config-toml-and-the-agents-md-codegraph-block-704.cases';
import { LEGACY_BLOCK, mkTmpDir, setHome } from './installer-targets.fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

export function registerInstallerTargetsPartialStateIdempotencyTests(): void {


  describe('Installer targets — partial-state idempotency', () => {
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

    registerCodexInstallWritesConfigTomlAndTheAgentsMdCodegraphBlock704Tests({
      get tmpHome() { return tmpHome; }, set tmpHome(value) { tmpHome = value; },
      get LEGACY_BLOCK() { return LEGACY_BLOCK; },
    });

    it('gemini + antigravity: both installed coexist (separate MCP files, shared GEMINI.md)', () => {
      const gemini = getTarget('gemini')!;
      const antigravity = getTarget('antigravity')!;
      gemini.install('global', { autoAllow: true });
      antigravity.install('global', { autoAllow: true });

      const cliCfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'settings.json'), 'utf-8'));
      // Antigravity lands on the LEGACY path here since no .migrated marker
      // was planted — same end-to-end check either way.
      const ideCfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json'), 'utf-8'));
      expect(cliCfg.mcpServers.codegraph).toBeDefined();
      expect(ideCfg.mcpServers.codegraph).toBeDefined();

      // Uninstall one — the other's MCP entry must survive.
      antigravity.uninstall('global');
      const cliAfter = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'settings.json'), 'utf-8'));
      expect(cliAfter.mcpServers.codegraph).toBeDefined();
    });

    it('hermes: install adds codegraph MCP server and cli toolset, preserving existing yaml', () => {
      const hermes = getTarget('hermes')!;
      const config = path.join(tmpHome, '.hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, [
        'model:',
        '  default: qwen-3.7',
        'mcp_servers:',
        '  other:',
        '    command: other',
        'platform_toolsets:',
        '  cli:',
        '    - hermes-cli',
        '  discord:',
        '    - hermes-discord',
        '',
      ].join('\n'));

      const result = hermes.install('global', { autoAllow: true });
      expect(result.files[0].action).toBe('updated');
      const body = fs.readFileSync(config, 'utf-8');
      expect(body).toContain('model:\n  default: qwen-3.7');
      expect(body).toContain('mcp_servers:\n  other:\n    command: other');
      expect(body).toContain('  codegraph:\n    command: codegraph');
      expect(body).toContain('    - hermes-cli');
      expect(body).toContain('    - mcp-codegraph');
      expect(body).toContain('  discord:\n    - hermes-discord');

      const second = hermes.install('global', { autoAllow: true });
      expect(second.files[0].action).toBe('unchanged');
    });

    it('hermes: uninstall removes only codegraph MCP server and toolset entry', () => {
      const hermes = getTarget('hermes')!;
      const config = path.join(tmpHome, '.hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(config), { recursive: true });

      hermes.install('global', { autoAllow: true });
      fs.appendFileSync(config, 'custom:\n  keep: true\n');

      hermes.uninstall('global');
      const body = fs.readFileSync(config, 'utf-8');
      expect(body).not.toContain('codegraph:');
      expect(body).not.toContain('mcp-codegraph');
      expect(body).toContain('custom:\n  keep: true');
    });

    // Regression for #456: PyYAML's default block style writes list items at the
    // SAME indent as the parent key (`cli:` and its `- hermes-cli` are both at
    // indent 2). The pre-fix line-based patcher mistook that first list item for
    // the next sibling key, truncated the cli block, and spliced `- mcp-codegraph`
    // at indent 4 BEFORE the existing items — producing unparseable YAML.
    it('hermes: install preserves PyYAML-default list-at-same-indent style (issue #456)', () => {
      const hermes = getTarget('hermes')!;
      const config = path.join(tmpHome, '.hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      const original = [
        'model:',
        '  default: gpt-4o',
        'platform_toolsets:',
        '  cli:',
        '  - hermes-cli',
        '  - browser',
        '  - clarify',
        '  - terminal',
        '  - web',
        '  telegram:',
        '  - hermes-telegram',
        '  discord:',
        '  - hermes-discord',
        '',
      ].join('\n');
      fs.writeFileSync(config, original);

      hermes.install('global', { autoAllow: true });
      const body = fs.readFileSync(config, 'utf-8');

      // mcp-codegraph appended at the same 2-space indent as existing items
      expect(body).toContain('\n  - mcp-codegraph\n');
      // hermes-cli preserved
      expect(body).toContain('\n  - hermes-cli\n');
      // Sibling sections kept their indent — `telegram:` is still a key under
      // platform_toolsets, not promoted up.
      expect(body).toContain('\n  telegram:\n  - hermes-telegram\n');
      expect(body).toContain('\n  discord:\n  - hermes-discord\n');
      // No list items leaked to the platform_toolsets level (indent 0).
      expect(body).not.toMatch(/^- browser/m);
      expect(body).not.toMatch(/^- hermes-telegram/m);

      // The whole platform_toolsets block extracted by line search should
      // start with `cli:` and not contain a stray 4-space `mcp-codegraph`
      // appearing before the rest of the existing items.
      expect(body).toContain('  cli:\n  - hermes-cli\n  - browser');

      // Idempotent
      const second = hermes.install('global', { autoAllow: true });
      expect(second.files[0]?.action).toBe('unchanged');
    });

    it('hermes: uninstall reverses the install on a PyYAML-default config', () => {
      const hermes = getTarget('hermes')!;
      const config = path.join(tmpHome, '.hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      const original = [
        'platform_toolsets:',
        '  cli:',
        '  - hermes-cli',
        '  - browser',
        '  telegram:',
        '  - hermes-telegram',
        '',
      ].join('\n');
      fs.writeFileSync(config, original);

      hermes.install('global', { autoAllow: true });
      const installed = fs.readFileSync(config, 'utf-8');
      expect(installed).toContain('- mcp-codegraph');
      expect(installed).toContain('codegraph:');

      hermes.uninstall('global');
      const body = fs.readFileSync(config, 'utf-8');
      expect(body).not.toContain('mcp-codegraph');
      expect(body).not.toContain('command: codegraph');
      expect(body).toContain('  cli:\n  - hermes-cli\n  - browser');
      expect(body).toContain('  telegram:\n  - hermes-telegram');
    });

    it('opencode: uninstall removes only mcp.codegraph, preserves comments and siblings', () => {
      const opencode = getTarget('opencode')!;
      const dir = path.join(tmpHome, '.config', 'opencode');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'opencode.jsonc');
      fs.writeFileSync(file, [
        '{',
        '  // important comment',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "mcp": {',
        '    "other": { "type": "local", "command": ["x"], "enabled": true }',
        '  }',
        '}',
        '',
      ].join('\n'));

      opencode.install('global', { autoAllow: true });
      const afterInstall = fs.readFileSync(file, 'utf-8');
      expect(afterInstall).toContain('"codegraph"');
      expect(afterInstall).toContain('"other"');

      opencode.uninstall('global');
      const afterUninstall = fs.readFileSync(file, 'utf-8');
      expect(afterUninstall).not.toContain('codegraph');
      expect(afterUninstall).toContain('// important comment');
      expect(afterUninstall).toContain('"other"');
    });

    it('codex: user-added key inside [mcp_servers.codegraph] survives idempotent re-install', () => {
      const codex = getTarget('codex')!;
      codex.install('global', { autoAllow: false });
      const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
      const original = fs.readFileSync(tomlPath, 'utf-8');
      // User edits the block to add a custom key.
      const edited = original.replace(
        'args = ["serve", "--mcp"]',
        'args = ["serve", "--mcp"]\nenabled = true',
      );
      fs.writeFileSync(tomlPath, edited);
      // Re-install: our serializer doesn't know `enabled = true`, so
      // the block no longer matches the canonical form — we'll
      // overwrite it. This is the documented contract: we own the
      // codegraph block exclusively.
      const second = codex.install('global', { autoAllow: false });
      const tomlEntry = second.files.find((f) => f.path.endsWith('config.toml'))!;
      expect(tomlEntry.action).toBe('updated');
      const after = fs.readFileSync(tomlPath, 'utf-8');
      expect(after).not.toContain('enabled = true');
    });

    it('codex: install, re-install, and uninstall preserve trailing array-of-tables siblings', () => {
      const codex = getTarget('codex')!;
      const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
      const historyTables = [
        '[[history]]',
        'id = 1',
        'note = "keep first"',
        '',
        '[[history]]',
        'id = 2',
        'note = "keep second"',
        '',
      ].join('\n');
      fs.writeFileSync(tomlPath, [
        '[mcp_servers.codegraph]',
        'command = "old-codegraph"',
        'args = ["old"]',
        'description = """',
        'header-shaped text inside a multiline string:',
        '[[not-a-table]]',
        'still part of the string',
        '"""',
        '',
        historyTables,
      ].join('\n'));

      const first = codex.install('global', { autoAllow: false });
      expect(first.files.find((f) => f.path === tomlPath)?.action).toBe('updated');
      const afterInstall = fs.readFileSync(tomlPath, 'utf-8');
      expect(afterInstall).toContain('command = "codegraph"');
      expect(afterInstall).not.toContain('[[not-a-table]]');
      expect(afterInstall.endsWith(historyTables)).toBe(true);

      const second = codex.install('global', { autoAllow: false });
      expect(second.files.find((f) => f.path === tomlPath)?.action).toBe('unchanged');
      expect(fs.readFileSync(tomlPath, 'utf-8')).toBe(afterInstall);

      codex.uninstall('global');
      expect(fs.readFileSync(tomlPath, 'utf-8')).toBe(historyTables);
    });

    it('claude: local install writes ./.mcp.json (project scope), not ./.claude.json', () => {
      const claude = getTarget('claude')!;
      const result = claude.install('local', { autoAllow: false });
      // The MCP entry lands in ./.mcp.json — the file Claude Code reads.
      expect(result.files.some((f) => f.path.replace(/\\/g, '/').endsWith('/.mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpCwd, '.mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpCwd, '.claude.json'))).toBe(false);
      const cfg = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
      expect(cfg.mcpServers.codegraph).toBeDefined();
    });

    it('claude: install creates the CLAUDE.md codegraph block (#704)', () => {
      const claude = getTarget('claude')!;
      const result = claude.install('local', { autoAllow: false });
      const claudeMd = path.join(tmpCwd, '.claude', 'CLAUDE.md');
      expect(fs.existsSync(claudeMd)).toBe(true);
      const body = fs.readFileSync(claudeMd, 'utf-8');
      expect(body).toContain('## CodeGraph');
      expect(body).toContain('codegraph explore');
      expect(result.files.find((f) => f.path.endsWith('CLAUDE.md'))?.action).toBe('created');
    });

    it('claude: install replaces a legacy CLAUDE.md codegraph block, keeping user content', () => {
      const claude = getTarget('claude')!;
      const claudeMd = path.join(tmpCwd, '.claude', 'CLAUDE.md');
      fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
      fs.writeFileSync(claudeMd, `# My project rules\n\nUse tabs.\n\n${LEGACY_BLOCK}\n`);

      const result = claude.install('local', { autoAllow: false });

      const body = fs.readFileSync(claudeMd, 'utf-8');
      expect(body).toContain('# My project rules');
      expect(body).toContain('Use tabs.');
      expect(body).not.toContain('Prefer `codegraph_search`');
      expect(body).toContain('codegraph explore');
      expect(result.files.find((f) => f.path.endsWith('CLAUDE.md'))?.action).toBe('updated');
    });

    it('claude: global install targets ~/.claude.json (user scope)', () => {
      const claude = getTarget('claude')!;
      claude.install('global', { autoAllow: false });
      const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'));
      expect(cfg.mcpServers.codegraph).toBeDefined();
    });

    it('claude: local install migrates a legacy ./.claude.json codegraph entry into ./.mcp.json', () => {
      const claude = getTarget('claude')!;
      const legacy = path.join(tmpCwd, '.claude.json');
      fs.writeFileSync(
        legacy,
        JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } } }, null, 2),
      );

      claude.install('local', { autoAllow: false });

      // codegraph now lives in .mcp.json; the legacy file (which held only
      // codegraph) is gone.
      const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers.codegraph).toBeDefined();
      expect(fs.existsSync(legacy)).toBe(false);
    });

    it('claude: legacy ./.claude.json migration preserves sibling servers and unrelated keys', () => {
      const claude = getTarget('claude')!;
      const legacy = path.join(tmpCwd, '.claude.json');
      fs.writeFileSync(
        legacy,
        JSON.stringify({
          mcpServers: {
            codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
            other: { command: 'x' },
          },
          somethingElse: true,
        }, null, 2),
      );

      claude.install('local', { autoAllow: false });

      // Only codegraph is stripped from the legacy file; siblings survive.
      const after = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
      expect(after.mcpServers.codegraph).toBeUndefined();
      expect(after.mcpServers.other).toBeDefined();
      expect(after.somethingElse).toBe(true);
      const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers.codegraph).toBeDefined();
    });

    it('claude: uninstall strips codegraph from ./.mcp.json and a legacy ./.claude.json', () => {
      const claude = getTarget('claude')!;
      // A user left with both the working .mcp.json and a stale .claude.json.
      fs.writeFileSync(
        path.join(tmpCwd, '.mcp.json'),
        JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph' } } }, null, 2),
      );
      fs.writeFileSync(
        path.join(tmpCwd, '.claude.json'),
        JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph' }, other: { command: 'x' } } }, null, 2),
      );

      claude.uninstall('local');

      const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers).toBeUndefined();
      const legacy = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.claude.json'), 'utf-8'));
      expect(legacy.mcpServers.codegraph).toBeUndefined();
      expect(legacy.mcpServers.other).toBeDefined();
    });

    // ---- Legacy auto-sync hook cleanup ----
    // Pre-0.8 installs wrote `codegraph mark-dirty` / `sync-if-dirty`
    // hooks to settings.json. Both subcommands were removed from the CLI,
    // so the Stop hook fails every turn ("unknown command
    // 'sync-if-dirty'"). The installer must strip them on upgrade and
    // uninstall — without touching the user's unrelated hooks.

    function seedSettings(loc: 'global' | 'local', settings: Record<string, any>): string {
      const dir = path.join(loc === 'global' ? tmpHome : tmpCwd, '.claude');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
      return file;
    }

    // Realistic pre-0.8 settings.json: our two auto-sync hooks plus an
    // unrelated GitKraken Stop hook the user added (matches the report).
    function legacyHookSettings(): Record<string, any> {
      return {
        hooks: {
          PostToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'codegraph mark-dirty', async: true }] },
          ],
          Stop: [
            { hooks: [{ type: 'command', command: 'codegraph sync-if-dirty' }] },
            { hooks: [{ type: 'command', command: '"/Users/me/gk" ai hook run --host claude-code' }] },
          ],
        },
      };
    }

    it('claude: install strips stale codegraph auto-sync hooks but keeps the user\'s GitKraken hook', () => {
      const claude = getTarget('claude')!;
      const file = seedSettings('global', legacyHookSettings());

      claude.install('global', { autoAllow: true });

      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // The only PostToolUse group held mark-dirty → the event is gone.
      expect(after.hooks?.PostToolUse).toBeUndefined();
      const stopCommands = (after.hooks?.Stop ?? []).flatMap((g: any) =>
        (g.hooks ?? []).map((h: any) => h.command),
      );
      expect(stopCommands).not.toContain('codegraph sync-if-dirty');
      // The unrelated GitKraken hook survives untouched.
      expect(stopCommands.some((c: string) => c.includes('gk') && c.includes('ai hook run'))).toBe(true);
      // Permissions still written as normal alongside the cleanup.
      expect(after.permissions?.allow).toContain('mcp__codegraph__*');
    });

    it('claude: cleanupLegacyHooks preserves a sibling hook sharing our matcher group', () => {
      const file = seedSettings('global', {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'codegraph sync-if-dirty' },
                { type: 'command', command: 'gk ai hook run --host claude-code' },
              ],
            },
          ],
        },
      });

      expect(cleanupLegacyHooks('global').action).toBe('removed');

      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after.hooks.Stop[0].hooks.map((h: any) => h.command)).toEqual([
        'gk ai hook run --host claude-code',
      ]);
    });

    it('claude: cleanupLegacyHooks is a byte-for-byte no-op without codegraph hooks', () => {
      const original =
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gk ai hook run' }] }] } }, null, 2) + '\n';
      const file = seedSettings('global', JSON.parse(original));

      expect(cleanupLegacyHooks('global').action).toBe('unchanged');
      expect(fs.readFileSync(file, 'utf-8')).toBe(original);
    });

    it('claude: cleanupLegacyHooks reports not-found when settings.json is absent', () => {
      expect(cleanupLegacyHooks('global').action).toBe('not-found');
    });

    it('claude: re-running install after a legacy cleanup leaves settings.json unchanged', () => {
      const claude = getTarget('claude')!;
      const file = seedSettings('global', legacyHookSettings());
      claude.install('global', { autoAllow: true });
      const firstPass = fs.readFileSync(file, 'utf-8');
      claude.install('global', { autoAllow: true });
      expect(fs.readFileSync(file, 'utf-8')).toBe(firstPass);
    });

    it('claude: uninstall strips stale hooks written in the npx form (local)', () => {
      const claude = getTarget('claude')!;
      const file = seedSettings('local', {
        hooks: {
          PostToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx @colbymchenry/codegraph mark-dirty', async: true }] },
          ],
          Stop: [
            { hooks: [{ type: 'command', command: 'npx @colbymchenry/codegraph sync-if-dirty' }] },
          ],
        },
      });

      claude.uninstall('local');

      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // Both events emptied → the whole `hooks` object is removed.
      expect(after.hooks).toBeUndefined();
    });

    // ---- Front-load prompt hook (UserPromptSubmit) — #841 follow-up ----
    // Opt-in (default-yes in the installer) UserPromptSubmit hook that runs
    // `codegraph prompt-hook`. Must write/remove surgically, be idempotent, and
    // round-trip an opt-out — without disturbing the user's own hooks.
    // Platform-aware since #1466: Windows writes `codegraph.cmd prompt-hook`
    // (Git Bash applies no PATHEXT, so the bare form is exit 127 there), and
    // install self-heals the other platform's spelling in place.
    const HOOK_CMD = process.platform === 'win32' ? 'codegraph.cmd prompt-hook' : 'codegraph prompt-hook';
    const OTHER_PLATFORM_HOOK_CMD = process.platform === 'win32' ? 'codegraph prompt-hook' : 'codegraph.cmd prompt-hook';
    const promptCommands = (s: any): string[] =>
      (s.hooks?.UserPromptSubmit ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

    it('claude: install with promptHook:true writes the UserPromptSubmit hook (alongside permissions)', () => {
      const claude = getTarget('claude')!;
      claude.install('global', { autoAllow: true, promptHook: true });
      const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
      expect(promptCommands(s)).toContain(HOOK_CMD);
      expect(s.permissions?.allow).toContain('mcp__codegraph__*');
    });

    it('claude: install without promptHook does NOT add the hook', () => {
      const claude = getTarget('claude')!;
      claude.install('global', { autoAllow: true });
      const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
      expect(promptCommands(s)).not.toContain(HOOK_CMD);
    });

    it('claude: install with promptHook:true is idempotent (no duplicate, byte-identical re-run)', () => {
      const claude = getTarget('claude')!;
      const file = path.join(tmpHome, '.claude', 'settings.json');
      claude.install('global', { autoAllow: true, promptHook: true });
      const first = fs.readFileSync(file, 'utf-8');
      claude.install('global', { autoAllow: true, promptHook: true });
      expect(fs.readFileSync(file, 'utf-8')).toBe(first);
      const s = JSON.parse(first);
      expect(promptCommands(s).filter((c: string) => c === HOOK_CMD)).toHaveLength(1);
    });

    it('claude: install with promptHook:false strips a hook a prior install wrote (opt-out round-trips)', () => {
      const claude = getTarget('claude')!;
      claude.install('global', { autoAllow: true, promptHook: true });
      claude.install('global', { autoAllow: true, promptHook: false });
      const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
      expect(promptCommands(s)).not.toContain(HOOK_CMD);
    });

    it('claude: writePromptHookEntry preserves a sibling UserPromptSubmit hook', () => {
      const file = seedSettings('global', {
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
      });
      expect(writePromptHookEntry('global').action).toBe('updated');
      const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(promptCommands(s)).toEqual(['my-own-hook', HOOK_CMD]);
    });

    it('claude: writePromptHookEntry migrates the other platform\'s spelling in place (#1466 self-heal)', () => {
      const file = seedSettings('global', {
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: OTHER_PLATFORM_HOOK_CMD }] }] },
      });
      expect(writePromptHookEntry('global').action).toBe('updated');
      const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(promptCommands(s)).toEqual([HOOK_CMD]);
      // A re-run after migration is byte-identical.
      const healed = fs.readFileSync(file, 'utf-8');
      expect(writePromptHookEntry('global').action).toBe('unchanged');
      expect(fs.readFileSync(file, 'utf-8')).toBe(healed);
    });

    it('claude: writePromptHookEntry leaves an npx-form hook untouched (no duplicate, no rewrite)', () => {
      const npxCmd = 'npx @colbymchenry/codegraph prompt-hook';
      const file = seedSettings('global', {
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: npxCmd }] }] },
      });
      expect(writePromptHookEntry('global').action).toBe('unchanged');
      const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(promptCommands(s)).toEqual([npxCmd]);
    });

    it('claude: uninstall removes the prompt hook but keeps the user\'s sibling', () => {
      const file = seedSettings('global', {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: HOOK_CMD }] },
            { hooks: [{ type: 'command', command: 'my-own-hook' }] },
          ],
        },
      });
      getTarget('claude')!.uninstall('global');
      const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(promptCommands(s)).toEqual(['my-own-hook']);
    });

    it('claude: removePromptHookEntry removes the other platform\'s spelling too', () => {
      const file = seedSettings('global', {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: OTHER_PLATFORM_HOOK_CMD }] }],
        },
      });
      expect(removePromptHookEntry('global').action).toBe('removed');
      const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(promptCommands(s)).toEqual([]);
    });

    it('claude: removePromptHookEntry leaves the legacy auto-sync hook untouched', () => {
      const file = seedSettings('global', {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'codegraph sync-if-dirty' }] }],
        },
      });
      expect(removePromptHookEntry('global').action).toBe('removed');
      const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(promptCommands(s)).not.toContain(HOOK_CMD);
      const stopCmds = (s.hooks?.Stop ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
      expect(stopCmds).toContain('codegraph sync-if-dirty');
    });
  });
}
