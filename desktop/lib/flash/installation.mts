import { constants, existsSync } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pluginRoot, pluginSelection, pluginVersionPath } from './plugin-package.mts';
import { fileURLToPath } from 'node:url';
import type { FlashReadiness } from '../../shared/settings.ts';

export const FLASH_REVISION = '635f484b4a1eff756f582b61dd4b9ee59430ae7c';
export const FLASH_MODEL = 'google/embeddinggemma-2';
export const FLASH_MODEL_REVISION = '914f7f89142e33e77833254d9c9b90c3cef7303b';
export const FLASH_MODEL_FILES = ['config.json', 'config_sentence_transformers.json', 'modules.json',
  'sentence_bert_config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors',
  '1_Pooling/config.json', '2_Normalize/config.json'] as const;

export function flashInstallationPaths(userData: string, env = process.env) {
  const root = join(userData, 'flash-install');
  const repository = join(root, FLASH_REVISION);
  const managedExecutable = join(repository, '.venv/bin/cheshi-flash');
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const developmentExecutable = join(dirname(checkout), 'cheshi-flash/.venv/bin/cheshi-flash');
  const legacyCache = join(homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'CheshiFlash/hub');
  const managedCache = join(root, 'models');
  const modelCache = env.CHESHI_FLASH_MODEL_CACHE?.trim() ||
    (existsSync(flashModelSnapshot(legacyCache)) ? legacyCache : managedCache);
  const selected = pluginSelection(userData);
  const pluginExecutable = selected.version ? join(pluginVersionPath(userData, selected.version), 'bin/cheshi-flash')
    : join(pluginRoot(userData), 'not-installed/bin/cheshi-flash');
  const executable = env.CHESHI_FLASH_EXECUTABLE?.trim() || (selected.exists ? pluginExecutable
    : (existsSync(repository) || checkout.includes('app.asar') ? managedExecutable : developmentExecutable));
  return { root, repository, managedExecutable, executable, modelCache };
}

export function flashModelSnapshot(cache: string) {
  return join(cache, 'models--google--embeddinggemma-2', 'snapshots', FLASH_MODEL_REVISION);
}

/** stat follows cache symlinks, so dangling or empty model blobs never pass. */
export async function inspectFlashInstallation(paths: { executable: string; modelCache: string }): Promise<FlashReadiness> {
  try {
    const info = await stat(paths.executable);
    if (!info.isFile()) return { ready: false, detail: 'Flash executable is missing. Install Flash to continue.' };
    await access(paths.executable, constants.R_OK | constants.X_OK);
    const file = await open(paths.executable, 'r');
    let header: string;
    try {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      header = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
    } finally { await file.close(); }
    if (header.startsWith('#!/') && !header.startsWith('#!/usr/bin/env ')) {
      await access(header.slice(2).trim(), constants.X_OK);
    }
  } catch { return { ready: false, detail: 'Flash executable or its Python runtime is missing or cannot be executed. Install Flash to continue.' }; }
  const snapshot = flashModelSnapshot(paths.modelCache);
  const missing: string[] = [];
  for (const name of FLASH_MODEL_FILES) {
    try {
      const file = join(snapshot, name), info = await stat(file);
      if (!info.isFile() || info.size === 0) { missing.push(name); continue; }
      await access(file, constants.R_OK);
    } catch { missing.push(name); }
  }
  if (missing.length) return { ready: false, detail: `EmbeddingGemma 2 is missing or incomplete (${missing.join(', ')}). Install Flash to download the required model.` };
  return { ready: true, detail: 'Flash files are available. Enabling Flash will verify that the model loads successfully.' };
}
