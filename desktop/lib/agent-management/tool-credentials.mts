import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicToolUrl } from '../../../experiments/codex-specialists/src/custom-tool-contract.ts';
interface Encryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export function createToolCredentials(directory: string, encryption: Encryption) {
  function filename(origin: string, name: string) {
    const url = publicToolUrl(origin);
    if (url.origin !== origin || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid tool credential scope.');
    return join(directory, `${createHash('sha256').update(JSON.stringify([origin, name])).digest('hex')}.enc`);
  }
  async function get(origin: string, name: string): Promise<string | null> {
    const file = filename(origin, name);
    try {
      const bytes = await readFile(file);
      if (!encryption.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
      return encryption.decryptString(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Could not read the tool credential securely.');
    }
  }
  return { get,
    async status(origin: string, name: string) { return Boolean(await get(origin, name)); },
    async save(origin: string, name: string, value: string) {
      const file = filename(origin, name);
      if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\r\n\0]/.test(value)) throw new Error('Invalid API key.');
      if (!encryption.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, encryption.encryptString(value.trim()), { mode: 0o600 }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
      return true;
    },
    async remove(origin: string, name: string) { await rm(filename(origin, name), { force: true }); return Boolean(await get(origin, name)); },
  };
}
