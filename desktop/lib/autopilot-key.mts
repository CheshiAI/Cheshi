import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Only the main process reads this key; signing variables are never installed into process.env. */
export function readAutopilotKey(options: { environment?: NodeJS.ProcessEnv; developmentFile?: string } = {}): string | null {
  const environment = options.environment ?? process.env;
  const value = environment.TYPE_SAFE_AI?.trim();
  if (value) return value;
  if (!options.developmentFile) return null;
  try { return parseEnv(readFileSync(options.developmentFile, 'utf8')).TYPE_SAFE_AI?.trim() || null; }
  catch { return null; }
}
