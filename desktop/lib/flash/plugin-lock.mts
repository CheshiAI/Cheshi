import { open, readFile, unlink } from 'node:fs/promises';

export async function lockPluginInstallation(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      return () => unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      let running = true;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false; }
      }
      if (running) return installationLocked();
      await unlink(path);
    }
  }
  return installationLocked();
}
function installationLocked(): never { throw new Error('Another Cheshi process is installing Flash. Wait for it to finish, then retry.'); }
