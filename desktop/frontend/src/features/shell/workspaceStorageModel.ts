import type { WorkspaceDiskUsage } from '../../../../shared/workspace-disk-usage';

const GB = 1_000_000_000;
const MB = 1_000_000;
export const STORAGE_REFRESH_MS = 5 * 60_000;

export function formatWorkspaceStorage(bytes: number): string {
  const unit = bytes >= GB ? GB : MB;
  const amount = bytes / unit;
  const label = unit === GB ? 'GB' : 'MB';
  if (amount > 0 && amount < 0.01) return `0.01 ${label}`;
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${label}`;
}

export function workspaceStorageLabels(usage: WorkspaceDiskUsage) {
  const percentage = usage.workspaceBytes / usage.totalBytes * 100;
  const percent = percentage > 0 && percentage < 0.01 ? '0.01%'
    : `${percentage.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  const size = formatWorkspaceStorage(usage.workspaceBytes);
  return { size, percent, title: `Workspace folder: ${size} of ${formatWorkspaceStorage(usage.totalBytes)} on this drive (${percent}).` };
}

/** Delay the first scan and skip background windows; no per-file-change rescans. */
export function observeWorkspaceStorage(
  read: () => Promise<WorkspaceDiskUsage>,
  update: (value: WorkspaceDiskUsage | null) => void,
) {
  let disposed = false;
  let pending = false;
  let lastAttempt: number | null = null;
  const refresh = async () => {
    if (disposed || pending || document.visibilityState === 'hidden'
      || (lastAttempt !== null && Date.now() - lastAttempt < STORAGE_REFRESH_MS)) return;
    pending = true;
    lastAttempt = Date.now();
    try {
      const value = await read();
      if (!disposed) update(value);
    } catch {
      if (!disposed) update(null);
    } finally { pending = false; }
  };
  const onVisible = () => { void refresh(); };
  const timeout = window.setTimeout(onVisible, 1_500);
  const interval = window.setInterval(onVisible, STORAGE_REFRESH_MS);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    disposed = true;
    window.clearTimeout(timeout);
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
