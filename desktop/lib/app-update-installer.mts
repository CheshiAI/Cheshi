import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AutoUpdater } from 'electron';
import type { AppRelease, AppUpdateProgress } from '../shared/app-update.ts';
import { downloadAppUpdate, serveAppUpdate } from './app-update-download.mts';

const runFile = promisify(execFile);

export async function appUpdateUnavailableReason(options: { packaged: boolean; platform: string; executable: string }): Promise<string | null> {
  if (!options.packaged) return 'Updates can only be installed from the packaged app.';
  if (options.platform !== 'darwin') return 'Install the new version from the release page on this platform.';
  const bundle = path.resolve(options.executable, '../../..');
  if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return 'Move the app to Applications and open it again before updating.';
  }
  try { await access(path.dirname(bundle), constants.W_OK); }
  catch { return 'The app installation folder is not writable. Install the new version from the release page.'; }
  try {
    const signature = await runFile('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { timeout: 10_000 });
    if (!/^TeamIdentifier=[A-Z0-9]+$/m.test(signature.stderr)
      || !/^Authority=Developer ID Application:/m.test(signature.stderr)) return 'Automatic installation requires a signed distribution app.';
    await runFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 20_000 });
    return null;
  } catch { return 'Automatic installation requires a validly signed distribution app.'; }
}

export async function stageAppUpdate(updater: Pick<AutoUpdater, 'on' | 'removeListener' | 'setFeedURL' | 'checkForUpdates'>, release: AppRelease,
  options: { download?: typeof downloadAppUpdate; serve?: typeof serveAppUpdate; timeoutMs?: number;
    onProgress?: (progress: AppUpdateProgress) => void } = {}) {
  if (!release.asset) throw new Error('No update asset is available for this device.');
  const download = await (options.download ?? downloadAppUpdate)(release.asset, {
    onProgress: (receivedBytes, totalBytes) => options.onProgress?.({ phase: 'downloading', receivedBytes, totalBytes }),
    onVerifying: () => options.onProgress?.({ phase: 'verifying' }),
  });
  let feed: Awaited<ReturnType<typeof serveAppUpdate>> | undefined;
  try {
    options.onProgress?.({ phase: 'installing' });
    feed = await (options.serve ?? serveAppUpdate)(release, download.filename);
    const url = feed.url;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        updater.removeListener('error', failed);
        updater.removeListener('update-downloaded', downloaded);
        updater.removeListener('update-not-available', unavailable);
      };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const downloaded = () => { cleanup(); resolve(); };
      const unavailable = () => { cleanup(); reject(new Error('The new update is unavailable for installation.')); };
      const timer = setTimeout(() => failed(new Error('Update installation preparation timed out.')), options.timeoutMs ?? 15 * 60_000);
      updater.on('error', failed);
      updater.on('update-downloaded', downloaded);
      updater.on('update-not-available', unavailable);
      try { updater.setFeedURL({ url, serverType: 'default' }); updater.checkForUpdates(); }
      catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
    });
  } finally { try { await feed?.dispose(); } finally { await download.dispose(); } }
}
