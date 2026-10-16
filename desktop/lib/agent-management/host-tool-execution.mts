import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { record } from '../../../experiments/codex-specialists/src/protocol.ts';
import { HOST_IMAGE_BYTES, imageDigest, validateHostPng, type HostToolResult } from '../../../experiments/codex-specialists/src/host-tool-artifacts.ts';

export interface HostProcessOptions {
  executable: string; script: string; cwd: string; output: string; cache: string;
  args: Record<string, unknown>; signal: AbortSignal; valid(): boolean; timeoutMs?: number;
}
export async function executeHostProcess(options: HostProcessOptions): Promise<HostToolResult> {
  options.signal.throwIfAborted();
  if (!options.valid()) throw new Error('Host tool permission changed.');
  const outputRoot = await realpath(options.output);
  options.signal.throwIfAborted();
  if (!options.valid()) throw new Error('Host tool permission changed.');
  const stdout = await new Promise<string>((resolveResult, reject) => {
    const child = spawn(options.executable, [options.script], { cwd: options.cwd, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      // Apps launched through macOS services can outlive this call and inherit these paths.
      // Per-call cleanup must not remove their user home or system temporary directory.
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: userInfo().homedir, TMPDIR: tmpdir(),
        LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1',
        HOMIE_TOOL_OUTPUT_DIR: options.output, HOMIE_TOOL_CACHE_DIR: options.cache } });
    let output = '', failure: Error | undefined;
    const kill = () => {
      if (!child.pid) return;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    };
    const stop = (message: string) => { failure ??= new Error(`${message} External completion is unknown; do not retry automatically.`); kill(); };
    const abort = () => stop('Host tool canceled.');
    const timer = setTimeout(() => stop('Host tool timed out.'), options.timeoutMs ?? 50_000);
    const monitor = setInterval(() => { if (!options.valid()) stop('Host tool permission changed.'); }, 100);
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      output += data;
      if (Buffer.byteLength(output) > 256 * 1024) stop('Host tool output exceeds 256 KiB.');
    });
    child.stderr.resume(); // Never put host diagnostics or inherited credentials into a worker response.
    child.stdin.on('error', () => stop('Host tool input failed.'));
    child.on('error', () => stop('Host executable could not start.'));
    child.once('close', code => {
      clearTimeout(timer); clearInterval(monitor); options.signal.removeEventListener('abort', abort);
      kill(); // Do not leave background children running after a one-shot tool returns.
      if (failure || code !== 0) reject(failure ?? new Error('Host tool exited unsuccessfully. External completion may be unknown.'));
      else resolveResult(output);
    });
    if (options.signal.aborted) abort();
    child.stdin.end(JSON.stringify(options.args));
  });
  options.signal.throwIfAborted();
  if (!options.valid()) throw new Error('Host tool permission changed.');
  const response = record(JSON.parse(stdout));
  if (!('result' in response) || Object.keys(response).some(key => !['result', 'images'].includes(key))) throw new Error('Expected host JSON result and optional images.');
  const paths = response.images ?? [];
  if (!Array.isArray(paths) || paths.length > 1) throw new Error('Host tools may return one PNG per call.');
  const images = [];
  const root = await realpath(options.output);
  if (root !== outputRoot) throw new Error('Host output directory changed.');
  for (const value of paths) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}\.png$/.test(value)) throw new Error('Use a PNG filename inside the output directory.');
    const target = resolve(root, value), actual = await realpath(target), rel = relative(root, actual);
    if (actual !== target || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Image is outside the tool output directory.');
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > HOST_IMAGE_BYTES) throw new Error('Invalid host image file.');
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== info.size) throw new Error('Host image changed during read.');
      const content = bytes.subarray(0, bytesRead); validateHostPng(content);
      images.push({ name: value, sha256: imageDigest(content), base64: content.toString('base64') });
    } finally { await file.close(); }
  }
  options.signal.throwIfAborted();
  if (!options.valid()) throw new Error('Host tool permission changed.');
  return { hostToolProtocol: 1, data: response.result, images };
}
