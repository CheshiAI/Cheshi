import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HomieSetupStatus } from '../shared/homie-setup.ts';
import { desktopToolPath } from './workspace-tool-status.mts';
import { findSetupTool, runSetupCommand, SetupCommandError, type SetupCommand } from './homie-setup-command.mts';

interface Options {
  platform?: string;
  home?: string;
  find?: typeof findSetupTool;
  run?: SetupCommand;
}
function requireSetup(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SetupCommandError(message);
}

/** One app-wide operation, shared by every settings window. Never stop an existing VM. */
export class HomieSetup {
  private readonly options: Options;
  private readonly stop = new AbortController();
  private pending: Promise<HomieSetupStatus> | null = null;
  private checking: Promise<HomieSetupStatus> | null = null;
  private revision = 0;
  private state: HomieSetupStatus;
  constructor(options: Options = {}) {
    this.options = options;
    this.state = { supported: (options.platform ?? process.platform) === 'darwin', brew: false, docker: false,
      colima: false, connected: false, busy: false, detail: 'Check the Docker environment for Homies.' };
  }
  private tool(name: 'brew' | 'docker' | 'colima') { return (this.options.find ?? findSetupTool)(name); }
  private get home() { return this.options.home ?? homedir(); }
  private get socket() { return `unix://${join(this.home, '.colima/default/docker.sock')}`; }
  private command(file: string, args: string[], timeout = 15_000, output?: (text: string) => void) {
    const env = { ...process.env, PATH: desktopToolPath(process.env.PATH), COLIMA_HOME: join(this.home, '.colima'),
      HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_UPGRADE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1',
      HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1', CI: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('DOCKER_')) delete (env as NodeJS.ProcessEnv)[key];
    return (this.options.run ?? runSetupCommand)(file, args, { env, timeout, signal: this.stop.signal, output });
  }
  private async inspect(): Promise<HomieSetupStatus> {
    const supported = this.state.supported;
    if (!supported) return { ...this.state, detail: 'Automatic Homies setup is available on macOS.' };
    const brew = this.tool('brew'), docker = this.tool('docker'), colima = this.tool('colima');
    let connected = false;
    let detail = !docker || !colima ? 'Install the missing Docker CLI and Colima tools.' : 'Colima is stopped or its Docker connection needs attention.';
    if (docker && colima) {
      try {
        const prefix = ['--config', join(this.home, '.docker')];
        const contexts = JSON.parse(await this.command(docker, [...prefix, 'context', 'inspect', 'colima'])) as unknown;
        requireSetup(Array.isArray(contexts) && contexts[0]?.Endpoints?.docker?.Host === this.socket,
          'The colima Docker context does not point to the default local Colima profile. Check its configuration.');
        await this.command(docker, [...prefix, '--host', this.socket, 'info', '--format', '{{.ServerVersion}}']);
        connected = true;
        detail = 'Colima Docker connection is ready. Select colima when creating a Homie. Project sharing and worker setup are checked separately.';
      } catch (error) { if (error instanceof SetupCommandError) detail = error.message; }
    }
    return { supported, brew: !!brew, docker: !!docker, colima: !!colima, connected, busy: false, detail };
  }
  async status(): Promise<HomieSetupStatus> {
    if (this.pending) return { ...this.state };
    if (!this.checking) {
      const revision = this.revision;
      this.checking = this.inspect().then(status => {
        if (!this.pending && revision === this.revision) this.state = { ...status, ...(!status.connected && this.state.error ? { error: this.state.error } : {}) };
        return { ...this.state };
      }).finally(() => { this.checking = null; });
    }
    return this.checking;
  }
  install() { return this.perform('Checking required tools…', async () => {
    const brew = this.tool('brew');
    requireSetup(brew, 'Install Homebrew from brew.sh first, then check again.');
    for (const name of ['colima', 'docker'] as const) {
      if (this.tool(name)) continue;
      this.state.detail = `Installing ${name} with Homebrew…`;
      let tail = '';
      await this.command(brew, ['install', '--formula', name], 30 * 60_000, chunk => {
        tail = (tail + chunk).slice(-4096);
        // Fixed labels only: package output may contain local paths or credentials.
        const lines = tail.split(/[\r\n]/); tail = lines.pop() ?? '';
        for (const line of lines) {
          if (/^(?:==>|✔|⠋).*?(?:Downloading|Fetching)/i.test(line)) this.state.detail = `Downloading ${name} and its dependencies…`;
          else if (/^==> (?:Installing|Pouring)/.test(line)) this.state.detail = `Installing ${name} and its dependencies…`;
        }
      });
      requireSetup(this.tool(name), `${name} was not found after installation. Check Homebrew and retry.`);
    }
  }); }
  start() { return this.perform('Starting Colima…', async () => {
    const colima = this.tool('colima');
    requireSetup(colima && this.tool('docker'), 'Install Colima and Docker CLI first.');
    await this.command(colima, ['--profile', 'default', 'start', '--runtime', 'docker', '--activate=false'], 10 * 60_000);
    this.state.detail = 'Checking the Colima Docker connection…';
    const status = await this.inspect();
    requireSetup(status.connected, status.detail);
  }); }
  private perform(detail: string, action: () => Promise<void>): Promise<HomieSetupStatus> {
    if (this.pending) return this.pending;
    if (!this.state.supported) return Promise.reject(new Error('Automatic setup requires macOS.'));
    this.revision++;
    this.state = { ...this.state, busy: true, error: undefined, startedAt: Date.now(), detail };
    this.pending = (async () => {
      try {
        await action();
        this.state = await this.inspect();
      } catch (error) {
        const reason = error instanceof SetupCommandError ? error.message : 'Setup failed. Check Homebrew, Colima and network access, then retry.';
        this.state = { ...this.state, error: `${this.state.detail} ${reason}` };
      } finally {
        this.state = { ...this.state, busy: false, startedAt: undefined };
        this.pending = null;
      }
      return { ...this.state };
    })();
    return this.pending;
  }
  dispose() { this.stop.abort(); }
}
