import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAutopilotMenuVisible, parseTypeSafeKey } from '../shared/settings.ts';
import type { TypeSafeSettings } from '../shared/settings.ts';

interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface Options {
  directory: string;
  settingsPath: string;
  encryption: Encryption;
  fallback(): string | null;
  checkKey(key: string): Promise<void>;
}
/** The ciphertext is stored in app data; the encryption key belongs to the OS credential store. */
export function createSettingsService(options: Options) {
  const filename = path.join(options.directory, 'typesafe-api-key.enc');
  let cached: string | undefined;
  const listeners = new Set<(state: TypeSafeSettings) => void>();
  const readPreferences = (): Record<string, unknown> => {
    try {
      return assertPreferences(JSON.parse(readFileSync(options.settingsPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('Could not read app settings.');
    }
  };
  const writeMenuPreference = (visible: boolean) => {
    const temporary = `${options.settingsPath}.${randomUUID()}.tmp`;
    try {
      const preferences = { ...readPreferences(), autopilotMenuVisible: visible };
      mkdirSync(path.dirname(options.settingsPath), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, options.settingsPath);
    } catch { throw new Error('Could not save the Autopilot menu setting. Try again.'); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* A failed write does not replace the saved preference. */ } }
  };
  const available = () => { try { return options.encryption.isEncryptionAvailable() === true; } catch { return false; } };
  const saved = () => existsSync(filename);
  const readSaved = () => {
    if (!available()) throw new Error('Secure storage is unavailable. Unlock your system credential store and try again.');
    if (cached !== undefined) return cached;
    try {
      const encrypted = readFileSync(filename);
      assertEncryptedSize(encrypted);
      cached = parseTypeSafeKey(options.encryption.decryptString(encrypted));
      return cached;
    } catch { throw new Error('The saved API key could not be unlocked. Try again or replace the key.'); }
  };
  const getKey = (): string | null => {
    if (!saved()) { cached = undefined; return options.fallback(); }
    try { return readSaved(); } catch { return null; }
  };
  const snapshot = (): TypeSafeSettings => {
    const source = saved() ? 'saved' : options.fallback() ? 'environment' : 'none';
    let key: string | null = null, error: string | null = null;
    let autopilotMenuVisible = false;
    try { key = source === 'saved' ? readSaved() : options.fallback(); }
    catch (cause) { error = (cause as Error).message; }
    try { autopilotMenuVisible = readPreferences().autopilotMenuVisible === true; }
    catch (cause) { error ??= (cause as Error).message; }
    return { source, maskedKey: key ? `••••${key.length > 8 ? key.slice(-4) : ''}` : null, canSave: available(), error,
      autopilotMenuVisible };
  };
  const publish = () => {
    const state = snapshot();
    for (const listener of listeners) listener(state);
    return state;
  };
  return {
    getKey, snapshot,
    subscribe(listener: (state: TypeSafeSettings) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setAutopilotMenuVisible(value: unknown) {
      const visible = parseAutopilotMenuVisible(value);
      if (visible && !getKey()) throw new Error('Register or unlock a TypeSafe API key first.');
      writeMenuPreference(visible);
      return publish();
    },
    save(value: unknown) {
      const key = parseTypeSafeKey(value);
      if (!available()) throw new Error('Secure storage is unavailable. The API key was not saved.');
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        const encrypted = options.encryption.encryptString(key);
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, filename);
        cached = key;
      } catch { throw new Error('Could not securely save the API key. The previous key was retained.'); }
      finally { try { rmSync(temporary, { force: true }); } catch { /* No plaintext is written to this path. */ } }
      return publish();
    },
    remove() {
      if (!options.fallback()) writeMenuPreference(false);
      try { rmSync(filename, { force: true }); }
      catch { throw new Error('Could not remove the saved API key.'); }
      cached = undefined;
      return publish();
    },
    async check() {
      const key = getKey();
      if (!key) throw new Error('Register or unlock a TypeSafe API key first.');
      try { await options.checkKey(key); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : '';
        const safeMessages = [
          'TypeSafe rejected the API key or model access.',
          'TypeSafe usage limit reached. Try again later.',
          'Could not reach TypeSafe. Check your connection and try again.',
        ];
        throw new Error(safeMessages.includes(message) ? message : 'Could not verify the TypeSafe connection. Try again later.');
      }
      return true;
    },
  };
}

function assertEncryptedSize(value: Buffer): void {
  if (!value.length || value.length > 32_768) throw new Error('Invalid encrypted data.');
}

function assertPreferences(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid app settings.');
  return value as Record<string, unknown>;
}
