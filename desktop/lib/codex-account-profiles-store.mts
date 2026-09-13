import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { MAX_CODEX_ACCOUNT_PROFILES } from '../shared/codex-accounts.ts';

export interface StoredCodexAccountProfile { id: string; label: string }

function assertProfile(value: unknown): asserts value is StoredCodexAccountProfile {
  const entry = value as Partial<StoredCodexAccountProfile> | null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(entry.id)
    || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80) {
    throw new Error('Invalid saved Codex account profile.');
  }
}

function assertDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error('Codex accounts require an absolute storage directory.');
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Codex account storage must be a directory.');
}

/** Stores profile names and IDs only. Codex exclusively owns all authentication files. */
export class CodexAccountProfilesStore {
  readonly directory: string;
  private readonly filename: string;

  constructor(directory: string) {
    assertDirectory(directory);
    this.directory = resolve(directory);
    this.filename = join(this.directory, 'profiles.json');
  }

  async load(): Promise<StoredCodexAccountProfile[]> {
    let text: string;
    try { text = await readFile(this.filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Could not read saved Codex accounts.');
    }
    const parsed = JSON.parse(text) as { version?: unknown; profiles?: unknown } | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.profiles)
      || parsed.profiles.length >= MAX_CODEX_ACCOUNT_PROFILES) {
      throw new Error('Invalid saved Codex accounts.');
    }
    const ids = new Set<string>();
    return parsed.profiles.map((profile: unknown) => {
      assertProfile(profile);
      if (ids.has(profile.id)) throw new Error('Duplicate saved Codex account profile.');
      ids.add(profile.id);
      return { id: profile.id, label: profile.label };
    });
  }

  home(id: string): string {
    assertProfile({ id, label: 'Account' });
    return join(this.directory, id);
  }

  async createHome(id: string): Promise<string> {
    const home = this.home(id);
    await privateDirectory(this.directory);
    await privateDirectory(home);
    await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    return home;
  }

  async verifyHome(id: string): Promise<string> {
    const home = this.home(id);
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Saved Codex account directory is unavailable.');
    return home;
  }

  async save(profiles: StoredCodexAccountProfile[]): Promise<void> {
    for (const profile of profiles) assertProfile(profile);
    await privateDirectory(this.directory);
    const temporary = join(this.directory, `.profiles-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { await rename(temporary, this.filename); }
    finally { await unlink(temporary).catch(() => {}); }
  }
}
