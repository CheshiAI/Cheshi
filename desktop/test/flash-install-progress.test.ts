import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { FLASH_MODEL_DOWNLOAD_SCRIPT, flashDownloadProgressReader } from '../lib/flash/model-download.mts';
import type { FlashInstallProgress } from '../shared/settings.ts';

test('download progress handles split records, resumed bytes and completion without forwarding diagnostics', () => {
  const seen: FlashInstallProgress[] = [];
  const consume = flashDownloadProgressReader(1234, value => seen.push(value));
  consume('credential=private-fixture\n{}\n{"downloadedBytes":25,');
  consume('"totalBytes":100}\n{"downloadedBytes":100,"totalBytes":100}\n');
  expect(seen).toEqual([
    { startedAt: 1234, downloadedBytes: 25, totalBytes: 100 },
    { startedAt: 1234, downloadedBytes: 100, totalBytes: 100 },
  ]);
});

test('invalid or oversized records cannot corrupt progress and the next valid record recovers', () => {
  const seen: FlashInstallProgress[] = [];
  const consume = flashDownloadProgressReader(0, value => seen.push(value));
  consume('{"downloadedBytes":-1,"totalBytes":100}\n{"downloadedBytes":101,"totalBytes":100}\n');
  consume('{"downloadedBytes":"25","totalBytes":100}\n{"downloadedBytes":0,"totalBytes":0}\n');
  consume('x'.repeat(2000));
  consume('{"downloadedBytes":10,"totalBytes":100}\n');
  consume('{"downloadedBytes":50,"totalBytes":100}\n');
  expect(seen).toEqual([{ startedAt: 0, downloadedBytes: 50, totalBytes: 100 }]);
});

// Exercise the production Python callback without network access or a model download.
// The fixture exposes the pinned Hub's two byte bars plus its file-count bar.
const pythonFixture = `
import sys, types, json
source, scenario = json.loads(sys.stdin.read())
class Tqdm:
    def __init__(self, *args, **kwargs):
        self.n = kwargs.get('initial', 0)
    def update(self, n=1):
        self.n += n

def snapshot_download(**options):
    if options.get('dry_run'):
        sizes = [(20, False), (80, True)]
        if scenario == 'cached': sizes = [(100, False)]
        if scenario == 'unknown': sizes = [(None, True)]
        return [types.SimpleNamespace(file_size=size, will_download=download) for size, download in sizes]
    cls = options['tqdm_class']
    cls(unit='B', desc='Downloading bytes').update(400)
    cls(desc='Fetching 2 files').update(2)
    if scenario != 'cached':
        progress = cls(unit='B', desc='Reconstructing (incomplete total...)')
        progress.update(30)
        if scenario == 'failure': raise RuntimeError('fixture download failed')
        progress.update(50)

hub = types.ModuleType('huggingface_hub')
hub.snapshot_download = snapshot_download
auto = types.ModuleType('tqdm.auto')
auto.tqdm = Tqdm
sys.modules['huggingface_hub'] = hub
sys.modules['tqdm.auto'] = auto
sys.argv = ['download', 'fixture/model', 'revision', '/unused']
exec(source)
`;

function download(scenario: string) {
  const result = spawnSync('python3', ['-c', pythonFixture], {
    input: JSON.stringify([FLASH_MODEL_DOWNLOAD_SCRIPT, scenario]), encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  const progress: FlashInstallProgress[] = [];
  flashDownloadProgressReader(0, value => progress.push(value))(result.stdout);
  return { status: result.status, progress };
}

test('Python byte reporting counts cached bytes once and ignores transfer and file-count bars', () => {
  const result = download('partial');
  expect(result.status).toBe(0);
  expect(result.progress.map(value => value.downloadedBytes)).toEqual([20, 50, 100]);
  expect(result.progress.every(value => value.totalBytes === 100)).toBe(true);
});

test('Python handles fully cached models and unknown sizes without making up a percentage', () => {
  const cached = download('cached');
  expect(cached.status).toBe(0);
  expect(cached.progress.map(value => value.downloadedBytes)).toEqual([100, 100]);
  const unknown = download('unknown');
  expect(unknown.status).toBe(0);
  expect(unknown.progress).toEqual([]);
});

test('a failed Python download never publishes the final completion record', () => {
  const result = download('failure');
  expect(result.status).not.toBe(0);
  expect(result.progress.map(value => value.downloadedBytes)).toEqual([20, 50]);
});
