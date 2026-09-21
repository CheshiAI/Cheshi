import { readFileSync } from 'node:fs';
import path from 'node:path';

interface SecureStorage {
  isEncryptionAvailable(): boolean;
  decryptString(buffer: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/** Read-only access to Cheshi's existing key; plaintext never leaves the caller's process. */
export function skillFlowKey(directory: string, storage: SecureStorage): string | null {
  const key = process.env.TYPESAFE_API_KEY?.trim() || process.env.TYPE_SAFE_AI?.trim();
  if (key) return key;
  try {
    const encrypted = readFileSync(path.join(directory, 'api-keys', 'typesafe-api-key.enc'));
    assertStorage(storage);
    return storage.decryptString(encrypted);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('The saved TypeSafe key could not be unlocked.');
  }
}

function assertStorage(storage: SecureStorage): void {
  if (!storage.isEncryptionAvailable() || (process.platform === 'linux'
    && storage.getSelectedStorageBackend?.() === 'basic_text')) throw new Error('Secure storage unavailable.');
}
