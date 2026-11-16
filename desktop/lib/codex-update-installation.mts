import { accessSync, constants, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { desktopToolPath } from './workspace-tool-status.mts';
import { findSetupTool, runSetupCommand, type SetupCommand } from './homie-setup-command.mts';
import { codexVersion, parseCodexVersion, type CodexUpdateReporter } from '../shared/codex-update.ts';

export interface CodexInstallation { version: string; executable: string; brew: string | null; managed: boolean }
export function findCodexExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.CHESHI_CODEX?.trim() || 'codex';
  const candidates = isAbsolute(name) ? [name] : name.includes('/') || name.includes('\\') ? []
    : desktopToolPath(env.PATH).split(':').filter(isAbsolute).map(directory => join(directory, name));
  return candidates.find(file => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
  }) ?? null;
}
export function insideCodexCask(executable: string, caskroom: string): boolean {
  const path = relative(caskroom, executable);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}
export function createCodexInstallation(options: {
  command?: SetupCommand; executable?: () => string | null; brew?: () => string | null;
  realpath?: (path: string) => Promise<string>; fetch?: typeof fetch;
} = {}) {
  const controller = new AbortController();
  const run = (file: string, args: string[], timeout = 30_000, report?: CodexUpdateReporter) => (options.command ?? runSetupCommand)(file, args, {
    output: report ? () => report() : undefined,
    signal: controller.signal, timeout, env: { ...process.env, PATH: desktopToolPath(process.env.PATH),
      HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ANALYTICS: '1', NONINTERACTIVE: '1' },
  });
  async function inspect(): Promise<CodexInstallation> {
    const executable = (options.executable ?? findCodexExecutable)();
    if (!executable) throw new Error('Codex was not found. Check its installation.');
    const version = parseCodexVersion(await run(executable, ['--version']));
    const brew = process.platform === 'darwin' ? (options.brew ?? (() => findSetupTool('brew')))() : null;
    let managed = false;
    if (brew) {
      try {
        const paths = options.realpath ?? realpath;
        const caskroom = (await run(brew, ['--caskroom', 'codex'])).trim();
        managed = isAbsolute(caskroom) && insideCodexCask(await paths(executable), await paths(caskroom));
      } catch { /* Another installation remains visible, but must not be upgraded through Homebrew. */ }
    }
    return { executable, version, brew, managed };
  }
  return {
    inspect,
    async available(): Promise<string> {
      const response = await (options.fetch ?? fetch)('https://formulae.brew.sh/api/cask/codex.json', {
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error('Could not check the Homebrew Codex release.');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('token' in data) || data.token !== 'codex' || !('version' in data)) {
        throw new Error('Invalid Homebrew Codex release metadata.');
      }
      return codexVersion(data.version);
    },
    async upgrade(report?: CodexUpdateReporter) {
      // Resolve again immediately before mutation; never trust the renderer or a cached executable path.
      const current = await inspect();
      if (!current.managed || !current.brew) throw new Error('This Codex installation is not managed by Homebrew.');
      report?.('updating-local');
      await run(current.brew, ['upgrade', '--cask', 'codex'], 30 * 60_000, report);
      report?.('verifying-local');
      const updated = await inspect();
      if (!updated.managed) throw new Error('The active Codex executable changed during the update.');
      return updated;
    },
    dispose: () => controller.abort(),
  };
}
