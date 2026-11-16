import { execFile } from 'node:child_process';
import { parseFlashInstallProgress, type FlashInstallProgress } from '../../shared/settings.ts';

export type FlashInstallCommand = (file: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number;
  onOutput?: (chunk: string) => void;
}) => Promise<string>;
export const runFlashCommand: FlashInstallCommand = (file, args, { onOutput, ...options }) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { ...options, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
    (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => onOutput?.(chunk));
});

// The pinned Hub version supplies an aggregate reconstruction byte counter. Fix the
// denominator with a dry run so discovering another file cannot move the goalposts.
// Reused/resumed bytes count as available model data, including Xet reconstruction.
export const FLASH_MODEL_DOWNLOAD_SCRIPT = `
import sys, json, time, threading
from huggingface_hub import snapshot_download
from tqdm.auto import tqdm

options = dict(repo_id=sys.argv[1], revision=sys.argv[2], cache_dir=sys.argv[3])
files = snapshot_download(**options, dry_run=True)
known = all(isinstance(f.file_size, int) and f.file_size >= 0 for f in files)
total = sum(f.file_size for f in files) if known else 0
cached = sum(f.file_size for f in files if not f.will_download) if known else 0
lock = threading.RLock()

def report(received):
    if total > 0:
        print(json.dumps(dict(downloadedBytes=min(total, max(0, int(received))), totalBytes=total)), flush=True)

class Progress(tqdm):
    def __init__(self, *args, **kwargs):
        self.report_bytes = kwargs.get('unit') == 'B' and kwargs.get('desc', '').startswith('Reconstructing')
        self.last_report = 0
        kwargs['disable'] = False
        super().__init__(*args, **kwargs)

    def display(self, *args, **kwargs):
        pass

    def update(self, n=1):
        with lock:
            result = super().update(n)
            now = time.monotonic()
            if self.report_bytes and now - self.last_report >= 0.25:
                self.last_report = now
                report(cached + self.n)
            return result

report(cached)
snapshot_download(**options, tqdm_class=Progress)
report(total)
`;

/** Only bounded numeric records cross into the UI; never forward child diagnostics. */
export function flashDownloadProgressReader(startedAt: number, publish: (progress: FlashInstallProgress) => void) {
  let buffer = '', discard = false;
  return (chunk: string) => {
    for (const character of chunk) {
      if (character === '\n') {
        if (!discard) {
          try {
            const record = JSON.parse(buffer);
            if (record?.downloadedBytes !== undefined && record?.totalBytes !== undefined) {
              publish(parseFlashInstallProgress({ ...record, startedAt }));
            }
          }
          catch { /* Ignore unrelated or malformed subprocess output. */ }
        }
        buffer = ''; discard = false;
      } else if (!discard) {
        buffer += character;
        if (buffer.length > 1024) { buffer = ''; discard = true; }
      }
    }
  };
}
