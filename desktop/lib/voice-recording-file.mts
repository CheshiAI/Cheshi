import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertRecordingId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new TypeError('Invalid recording ID.');
  }
}
function assertAudioSchema(columns: Set<string>): void {
  if (!columns.has('ZPATH')) throw new Error('Recording file unavailable.');
}
function assertContained(root: string, filename: string): void {
  const entry = relative(root, filename);
  if (!entry || entry === '..' || entry.startsWith(`..${sep}`) || isAbsolute(entry)
    || !['.m4a', '.mp4', '.wav', '.caf', '.aif', '.aiff', '.qta'].includes(extname(filename).toLowerCase())) {
    throw new Error('Recording file unavailable.');
  }
}
/** Apple owns the DB; only a current, non-deleted row can authorize an audio file. */
export async function resolveVoiceRecordingFile(database: string, id: string): Promise<string> {
  assertRecordingId(id);
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  let stored: unknown;
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(ZCLOUDRECORDING)').all().map(row => String(row.name)));
    assertAudioSchema(columns);
    const deleted = ['ZMARKEDFORDELETION', 'ZDELETIONDATE', 'ZTRASHEDDATE'].filter(name => columns.has(name));
    stored = db.prepare(`SELECT ZPATH FROM ZCLOUDRECORDING WHERE Z_PK = ?
      ${deleted.map(name => `AND COALESCE(${name}, 0) = 0`).join(' ')}`).get(Number(id))?.ZPATH;
  } finally { db.close(); }
  if (typeof stored !== 'string' || !stored || stored.includes('\0')) throw new Error('Recording file unavailable.');
  const directory = resolve(dirname(database));
  const candidate = stored.startsWith('file:') ? fileURLToPath(stored) : resolve(directory, stored);
  assertContained(directory, candidate);
  const [root, filename] = await Promise.all([realpath(directory), realpath(candidate)]);
  assertContained(root, filename);
  if (!(await stat(filename)).isFile()) throw new Error('Recording file unavailable.');
  return filename;
}
