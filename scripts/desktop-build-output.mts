import { mkdir, access, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export function buildTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${value('year')}${value('month')}${value('day')}-${value('hour')}${value('minute')}${value('second')}`;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Atomic staging reservation protects previous builds and concurrent invocations. */
export async function reserveBuildOutput(out: string, date = new Date()) {
  await mkdir(out, { recursive: true });
  const timestamp = buildTimestamp(date);
  for (let sequence = 0; sequence < 10_000; sequence++) {
    const name = `${timestamp}${sequence ? `-${String(sequence).padStart(4, '0')}` : ''}`;
    const destination = join(out, name), staging = join(out, `.building-${name}`);
    if (await exists(destination)) continue;
    try {
      await mkdir(staging);
      // A previous owner may have finished between our existence check and mkdir.
      if (await exists(destination)) { await rmdir(staging); continue; }
      return { name, staging, destination };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new Error('No unused build output name is available.');
}

export const finderBuildSortScript = `on run argv
  set outputFolder to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    set outputWindow to missing value
    repeat with candidate in (get Finder windows)
      try
        set candidateWindow to contents of candidate
        if (target of candidateWindow as alias) is outputFolder then
          set outputWindow to candidateWindow
          exit repeat
        end if
      end try
    end repeat
    if outputWindow is missing value then set outputWindow to make new Finder window to outputFolder
    set current view of outputWindow to list view
    set options to list view options of outputWindow
    set visible of column id creation date column of options to true
    set sort column of options to creation date column
    set sort direction of column id creation date column of options to reversed
    return (current view of outputWindow is list view) and (sort direction of column id creation date column of options is reversed)
  end tell
end run`;
