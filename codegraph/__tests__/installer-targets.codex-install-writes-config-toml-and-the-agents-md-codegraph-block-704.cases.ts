import { expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { getTarget } from '../src/installer/targets/registry';

export function registerCodexInstallWritesConfigTomlAndTheAgentsMdCodegraphBlock704Tests(scope: {
  tmpHome: string;
  LEGACY_BLOCK: string;
}): void {


  it('codex: install writes config.toml AND the AGENTS.md codegraph block (#704)', () => {
    const codex = getTarget('codex')!;
    const first = codex.install('global', { autoAllow: false });
    const agentsMd = path.join(scope.tmpHome, '.codex', 'AGENTS.md');
    expect(first.files.some((f) => f.path.endsWith('config.toml'))).toBe(true);
    // The short instructions block IS written (subagents / non-MCP
    // harnesses read AGENTS.md but never the MCP initialize instructions).
    expect(fs.existsSync(agentsMd)).toBe(true);
    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('## CodeGraph');
    expect(body).toContain('codegraph explore');
    // Re-install is fully unchanged (byte-equal block → idempotent).
    const second = codex.install('global', { autoAllow: false });
    for (const f of second.files) expect(f.action).toBe('unchanged');
  });


  it('codex: forwards the central CodeGraph data root to the MCP server', () => {
    const dataRoot = path.join(scope.tmpHome, 'Library', 'Application Support', 'Cheshi');
    process.env.CODEGRAPH_DATA_ROOT = dataRoot;
    const codex = getTarget('codex')!;

    codex.install('global', { autoAllow: false });

    const config = fs.readFileSync(path.join(scope.tmpHome, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain(`env = { CODEGRAPH_DATA_ROOT = "${dataRoot}" }`);
  });


  it('codex: install replaces a legacy AGENTS.md codegraph block with the current one, keeping user content', () => {
    const codex = getTarget('codex')!;
    const dir = path.join(scope.tmpHome, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `# My codex notes\n\nBe terse.\n\n${scope.LEGACY_BLOCK}\n`);

    const result = codex.install('global', { autoAllow: false });

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My codex notes');
    expect(body).toContain('Be terse.');
    // Self-heal: the stale pre-#529 body is gone, the current block is in.
    expect(body).not.toContain('Prefer `codegraph_search`');
    expect(body).toContain('codegraph explore');
    const mdEntry = result.files.find((f) => f.path.endsWith('AGENTS.md'));
    expect(mdEntry?.action).toBe('updated');
  });


  it('opencode: prefers .jsonc when both .json and .jsonc exist', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(scope.tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
    fs.writeFileSync(path.join(dir, 'opencode.jsonc'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');

    const result = opencode.install('global', { autoAllow: true });
    const written = result.files.find((f) => /\.jsonc$/.test(f.path))!;
    expect(written).toBeDefined();
    expect(written.action).not.toBe('not-found');
    // The .json file is left alone.
    const jsonText = fs.readFileSync(path.join(dir, 'opencode.json'), 'utf-8');
    expect(jsonText).not.toContain('codegraph');
  });


  it('opencode: uses .json when only .json exists (no .jsonc)', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(scope.tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');

    const result = opencode.install('global', { autoAllow: true });
    expect(result.files[0].path).toMatch(/opencode\.json$/);
    expect(fs.existsSync(path.join(dir, 'opencode.jsonc'))).toBe(false);
  });


  it('opencode: defaults to .jsonc for fresh installs (no existing file)', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });
    expect(result.files[0].path).toMatch(/opencode\.jsonc$/);
    expect(result.files[0].action).toBe('created');
  });


  it('opencode: preserves line and block comments through install + idempotent re-run', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(scope.tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.jsonc');
    const original = [
      '{',
      '  // top-level note about my opencode setup',
      '  "$schema": "https://opencode.ai/config.json",',
      '  /* multi-line block comment',
      '     describing the providers section */',
      '  "providers": {',
      '    "anthropic": { "model": "claude-opus-4-7" } // pinned',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(file, original);

    opencode.install('global', { autoAllow: true });
    const afterInstall = fs.readFileSync(file, 'utf-8');
    expect(afterInstall).toContain('// top-level note about my opencode setup');
    expect(afterInstall).toContain('/* multi-line block comment');
    expect(afterInstall).toContain('// pinned');
    expect(afterInstall).toContain('"codegraph"');
    expect(afterInstall).toContain('"providers"');

    // Idempotent re-run reports unchanged, file is byte-identical.
    const second = opencode.install('global', { autoAllow: true });
    expect(second.files[0].action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(afterInstall);
  });


  it('opencode: install writes the AGENTS.md codegraph block (#704)', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });
    const agentsMd = path.join(scope.tmpHome, '.config', 'opencode', 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    expect(fs.readFileSync(agentsMd, 'utf-8')).toContain('codegraph explore');
    expect(result.files.find((f) => f.path.endsWith('AGENTS.md'))?.action).toBe('created');
  });


  it('opencode: install replaces a legacy AGENTS.md codegraph block, preserving user content', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(scope.tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `# My personal opencode instructions\n\nAlways respond in pirate.\n\n${scope.LEGACY_BLOCK}\n`);

    const result = opencode.install('global', { autoAllow: true });

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).not.toContain('Prefer `codegraph_search`');
    expect(body).toContain('codegraph explore');
    expect(result.files.find((f) => f.path.endsWith('AGENTS.md'))?.action).toBe('updated');
  });


  it('opencode: uninstall strips a leftover codegraph block from AGENTS.md, keeping user content', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(scope.tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `# My personal opencode instructions\n\nAlways respond in pirate.\n\n${scope.LEGACY_BLOCK}\n`);

    opencode.uninstall('global');

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).not.toContain('CODEGRAPH_START');
  });


  it('opencode: local install writes ./opencode.jsonc and the ./AGENTS.md block (#704)', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    // macOS realpath shenanigans (/var vs /private/var) — suffix match.
    expect(paths.some((p) => p.endsWith('/opencode.jsonc'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'AGENTS.md'))).toBe(true);
  });


  it('gemini: install writes settings.json (mcpServers.codegraph) and the GEMINI.md block (#704)', () => {
    const gemini = getTarget('gemini')!;
    const result = gemini.install('global', { autoAllow: true });
    const settings = path.join(scope.tmpHome, '.gemini', 'settings.json');
    const geminiMd = path.join(scope.tmpHome, '.gemini', 'GEMINI.md');
    expect(result.files.some((f) => f.path === settings)).toBe(true);
    expect(result.files.some((f) => f.path === geminiMd)).toBe(true);
    expect(fs.existsSync(geminiMd)).toBe(true);
    expect(fs.readFileSync(geminiMd, 'utf-8')).toContain('codegraph explore');

    const cfg = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toEqual({ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] });
  });


  it('gemini: install preserves pre-existing settings (security.auth survives)', () => {
    //noinspection DuplicatedCode
    const gemini = getTarget('gemini')!;
    const settings = path.join(scope.tmpHome, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' } },
    }, null, 2) + '\n');

    gemini.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(after.security?.auth?.selectedType).toBe('oauth-personal');
    expect(after.mcpServers?.codegraph).toBeDefined();
  });


  it('gemini: uninstall strips codegraph but leaves pre-existing settings (security.auth) intact', () => {
    //noinspection DuplicatedCode
    const gemini = getTarget('gemini')!;
    const settings = path.join(scope.tmpHome, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' } },
    }, null, 2) + '\n');

    gemini.install('global', { autoAllow: true });
    gemini.uninstall('global');

    const after = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(after.security?.auth?.selectedType).toBe('oauth-personal');
    expect(after.mcpServers).toBeUndefined();
  });


  it('gemini: local install writes ./.gemini/settings.json and the project-root ./GEMINI.md block (#704)', () => {
    const gemini = getTarget('gemini')!;
    const result = gemini.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    expect(paths.some((p) => p.endsWith('/.gemini/settings.json'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/GEMINI.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'GEMINI.md'))).toBe(true);
  });


  it('gemini: uninstall strips a leftover GEMINI.md codegraph block, keeping user content', () => {
    const gemini = getTarget('gemini')!;
    const geminiMd = path.join(scope.tmpHome, '.gemini', 'GEMINI.md');
    fs.mkdirSync(path.dirname(geminiMd), { recursive: true });
    fs.writeFileSync(geminiMd, `# My personal Gemini context\n\nAlways respond concisely.\n\n${scope.LEGACY_BLOCK}\n`);

    gemini.uninstall('global');

    const body = fs.readFileSync(geminiMd, 'utf-8');
    expect(body).toContain('# My personal Gemini context');
    expect(body).toContain('Always respond concisely.');
    expect(body).not.toContain('CODEGRAPH_START');
  });


  it('kiro: install writes settings/mcp.json (mcpServers.codegraph) and no steering doc (#529)', () => {
    const kiro = getTarget('kiro')!;
    const result = kiro.install('global', { autoAllow: true });
    const mcp = path.join(scope.tmpHome, '.kiro', 'settings', 'mcp.json');
    const steering = path.join(scope.tmpHome, '.kiro', 'steering', 'codegraph.md');
    expect(result.files.some((f) => f.path === mcp)).toBe(true);
    expect(result.files.some((f) => f.path === steering)).toBe(false);
    expect(fs.existsSync(steering)).toBe(false);

    const cfg = JSON.parse(fs.readFileSync(mcp, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toEqual({ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] });
  });


  it('kiro: install deletes a leftover steering codegraph.md (self-heal) (#529)', () => {
    const kiro = getTarget('kiro')!;
    const steering = path.join(scope.tmpHome, '.kiro', 'steering', 'codegraph.md');
    fs.mkdirSync(path.dirname(steering), { recursive: true });
    fs.writeFileSync(steering, `${scope.LEGACY_BLOCK}\n`);

    const result = kiro.install('global', { autoAllow: true });
    expect(fs.existsSync(steering)).toBe(false);
    expect(result.files.find((f) => f.path === steering)?.action).toBe('removed');
  });


  it('kiro: install preserves a pre-existing sibling MCP server in mcp.json', () => {
    //noinspection DuplicatedCode
    const kiro = getTarget('kiro')!;
    const mcp = path.join(scope.tmpHome, '.kiro', 'settings', 'mcp.json');
    fs.mkdirSync(path.dirname(mcp), { recursive: true });
    fs.writeFileSync(mcp, JSON.stringify({
      mcpServers: { other: { command: 'uvx', args: ['other-server'] } },
    }, null, 2) + '\n');

    kiro.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(mcp, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeDefined();
  });


  it('kiro: uninstall strips codegraph but leaves sibling MCP servers intact', () => {
    //noinspection DuplicatedCode
    const kiro = getTarget('kiro')!;
    const mcp = path.join(scope.tmpHome, '.kiro', 'settings', 'mcp.json');
    fs.mkdirSync(path.dirname(mcp), { recursive: true });
    fs.writeFileSync(mcp, JSON.stringify({
      mcpServers: { other: { command: 'uvx', args: ['other-server'] } },
    }, null, 2) + '\n');

    kiro.install('global', { autoAllow: true });
    kiro.uninstall('global');

    const after = JSON.parse(fs.readFileSync(mcp, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeUndefined();
  });


  it('kiro: uninstall removes a leftover steering codegraph.md file outright', () => {
    const kiro = getTarget('kiro')!;
    const steering = path.join(scope.tmpHome, '.kiro', 'steering', 'codegraph.md');
    fs.mkdirSync(path.dirname(steering), { recursive: true });
    fs.writeFileSync(steering, `${scope.LEGACY_BLOCK}\n`);

    kiro.uninstall('global');
    expect(fs.existsSync(steering)).toBe(false);
  });


  it('kiro: uninstall removes our steering doc but leaves a sibling (product.md) untouched', () => {
    const kiro = getTarget('kiro')!;
    const sibling = path.join(scope.tmpHome, '.kiro', 'steering', 'product.md');
    const ours = path.join(scope.tmpHome, '.kiro', 'steering', 'codegraph.md');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, '# Product\n\nMy team practices.\n');
    fs.writeFileSync(ours, `${scope.LEGACY_BLOCK}\n`);

    kiro.uninstall('global');

    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.readFileSync(sibling, 'utf-8')).toContain('My team practices.');
  });


  it('kiro: local install writes ./.kiro/settings/mcp.json and no steering doc (#529)', () => {
    const kiro = getTarget('kiro')!;
    const result = kiro.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    expect(paths.some((p) => p.endsWith('/.kiro/settings/mcp.json'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/.kiro/steering/codegraph.md'))).toBe(false);
  });


  it('antigravity: install writes to LEGACY ~/.gemini/antigravity/mcp_config.json when no migration marker', () => {
    const antigravity = getTarget('antigravity')!;
    antigravity.install('global', { autoAllow: true });

    const legacyFile = path.join(scope.tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    expect(fs.existsSync(legacyFile)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toBeDefined();
    // Crucially: does NOT touch the Gemini CLI's settings.json.
    expect(fs.existsSync(path.join(scope.tmpHome, '.gemini', 'settings.json'))).toBe(false);
  });


  it('antigravity: install writes to UNIFIED ~/.gemini/config/mcp_config.json when .migrated marker present', () => {
    const antigravity = getTarget('antigravity')!;
    // Plant the migration marker — same signal Antigravity itself drops
    // when it migrates a user's config.
    const unifiedDir = path.join(scope.tmpHome, '.gemini', 'config');
    fs.mkdirSync(unifiedDir, { recursive: true });
    fs.writeFileSync(path.join(unifiedDir, '.migrated'), '');

    antigravity.install('global', { autoAllow: true });

    const unifiedFile = path.join(unifiedDir, 'mcp_config.json');
    expect(fs.existsSync(unifiedFile)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(unifiedFile, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toBeDefined();
    // Legacy path is NOT touched when the marker tells us migration happened.
    expect(fs.existsSync(path.join(scope.tmpHome, '.gemini', 'antigravity', 'mcp_config.json'))).toBe(false);
  });


  it('antigravity: install writes to UNIFIED path when ~/.gemini/config/mcp_config.json already exists (even without marker)', () => {
    const antigravity = getTarget('antigravity')!;
    // Antigravity creates this file on first launch post-migration — its
    // presence is the second signal we accept, in case the .migrated
    // marker semantics change across Antigravity versions.
    const unifiedFile = path.join(scope.tmpHome, '.gemini', 'config', 'mcp_config.json');
    fs.mkdirSync(path.dirname(unifiedFile), { recursive: true });
    fs.writeFileSync(unifiedFile, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');

    antigravity.install('global', { autoAllow: true });

    const cfg = JSON.parse(fs.readFileSync(unifiedFile, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toBeDefined();
  });


  it('antigravity: entry has NO `type` field (Antigravity rejects entries with it)', () => {
    const antigravity = getTarget('antigravity')!;
    // Marker → unified path; doesn't matter which path, just inspect the entry shape.
    fs.mkdirSync(path.join(scope.tmpHome, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(scope.tmpHome, '.gemini', 'config', '.migrated'), '');

    antigravity.install('global', { autoAllow: true });

    const cfg = JSON.parse(fs.readFileSync(
      path.join(scope.tmpHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'
    ));
    expect(cfg.mcpServers.codegraph.type).toBeUndefined();
    expect(cfg.mcpServers.codegraph.command).toBeDefined();
    expect(cfg.mcpServers.codegraph.args).toEqual(['serve', '--mcp']);
  });


  it('antigravity: install migrates a legacy codegraph entry to the unified path when marker appears', () => {
    const antigravity = getTarget('antigravity')!;
    // Simulate: user installed on the legacy path, then Antigravity
    // migrated their config (dropped the `.migrated` marker + created
    // the unified file). Re-running codegraph install should land
    // codegraph in the new file AND strip the stale legacy entry.
    const legacyFile = path.join(scope.tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({
      mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } },
    }, null, 2) + '\n');
    //noinspection DuplicatedCode
    fs.mkdirSync(path.join(scope.tmpHome, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(scope.tmpHome, '.gemini', 'config', '.migrated'), '');

    antigravity.install('global', { autoAllow: true });

    const unified = JSON.parse(fs.readFileSync(
      path.join(scope.tmpHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'
    ));
    expect(unified.mcpServers.codegraph).toBeDefined();
    // Legacy file's codegraph entry got stripped.
    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
    expect(legacy.mcpServers).toBeUndefined();
  });


  it('antigravity: install preserves a sibling MCP server in mcp_config.json (legacy path)', () => {
    //noinspection DuplicatedCode
    const antigravity = getTarget('antigravity')!;
    const mcpFile = path.join(scope.tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify({
      mcpServers: { other: { command: 'uvx', args: ['other-server'] } },
    }, null, 2) + '\n');

    antigravity.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeDefined();
  });


  it('antigravity: install preserves Antigravity-managed fields on sibling servers (e.g. disabled flag)', () => {
    const antigravity = getTarget('antigravity')!;
    // Antigravity adds `"disabled": true` to entries the user disables via
    // the IDE. Install must not clobber that on sibling entries.
    fs.mkdirSync(path.join(scope.tmpHome, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(scope.tmpHome, '.gemini', 'config', '.migrated'), '');
    const unified = path.join(scope.tmpHome, '.gemini', 'config', 'mcp_config.json');
    fs.writeFileSync(unified, JSON.stringify({
      mcpServers: {
        'code-review-graph': {
          command: 'uvx', args: ['code-review-graph', 'serve'], disabled: true,
        },
      },
    }, null, 2) + '\n');

    antigravity.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(unified, 'utf-8'));
    expect(after.mcpServers['code-review-graph'].disabled).toBe(true);
    expect(after.mcpServers.codegraph).toBeDefined();
  });


  it('antigravity: uninstall removes only codegraph, sibling MCP server survives', () => {
    //noinspection DuplicatedCode
    const antigravity = getTarget('antigravity')!;
    const mcpFile = path.join(scope.tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify({
      mcpServers: { other: { command: 'uvx', args: ['other-server'] } },
    }, null, 2) + '\n');

    antigravity.install('global', { autoAllow: true });
    antigravity.uninstall('global');

    const after = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeUndefined();
  });


  it('antigravity: uninstall sweeps BOTH legacy and unified paths (handles migration half-state)', () => {
    const antigravity = getTarget('antigravity')!;
    // User had codegraph in BOTH files (e.g. legacy install + post-migration
    // re-install before our migration cleanup landed). Uninstall must clean
    // both so a "fresh slate" really is fresh.
    const legacy = path.join(scope.tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    const unified = path.join(scope.tmpHome, '.gemini', 'config', 'mcp_config.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.mkdirSync(path.dirname(unified), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({
      mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } },
    }, null, 2) + '\n');
    fs.writeFileSync(unified, JSON.stringify({
      mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } },
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(path.dirname(unified), '.migrated'), '');

    antigravity.uninstall('global');

    const legacyAfter = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    const unifiedAfter = JSON.parse(fs.readFileSync(unified, 'utf-8'));
    expect(legacyAfter.mcpServers).toBeUndefined();
    expect(unifiedAfter.mcpServers).toBeUndefined();
  });


  it('antigravity: rejects --location=local with a clear note (global-only IDE)', () => {
    const antigravity = getTarget('antigravity')!;
    expect(antigravity.supportsLocation('local')).toBe(false);
    const result = antigravity.install('local', { autoAllow: true });
    expect(result.files).toEqual([]);
    expect(result.notes?.join(' ')).toMatch(/no project-local config/);
  });


  it('antigravity: does not write GEMINI.md (only gemini target owns instructions)', () => {
    const antigravity = getTarget('antigravity')!;
    antigravity.install('global', { autoAllow: true });
    const geminiMd = path.join(scope.tmpHome, '.gemini', 'GEMINI.md');
    expect(fs.existsSync(geminiMd)).toBe(false);
  });

}
