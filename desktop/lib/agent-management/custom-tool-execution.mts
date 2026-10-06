import { randomUUID } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { customToolArguments, publicToolUrl, type CustomTool } from '../../../experiments/codex-specialists/src/custom-tool-contract.ts';
import type { DockerCommand } from './docker.mts';
import { PACK_ROOT } from './pack-environment.mts';

export type ToolCredential = (origin: string, name: string) => Promise<string | null>;
const privateAddresses = new BlockList();
for (const [address, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) privateAddresses.addSubnet(address, bits);
export function publicIPv4(address: string) { return isIP(address) === 4 && !privateAddresses.check(address); }
/** DNS is resolved once and pinned to the socket; no redirects, ambient proxy, or private network access. */
export async function toolPost(url: URL, body: unknown, credential: string | null, signal: AbortSignal): Promise<unknown> {
  const addresses = await resolve4(url.hostname);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(address => !publicIPv4(address))) throw new Error('The tool endpoint must resolve to public IPv4 addresses.');
  const payload = JSON.stringify(body);
  if (payload === undefined || Buffer.byteLength(payload) > 64 * 1024) throw new Error('Tool request exceeds 64 KiB.');
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', signal, family: 4,
      lookup: (_host, options, callback) => options.all
        ? callback(null, addresses.map(address => ({ address, family: 4 }))) : callback(null, addresses[0]!, 4),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(credential ? { Authorization: `Bearer ${credential}` } : {}) } }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy(); reject(new Error(`Tool endpoint returned HTTP ${response.statusCode ?? 'unknown'}.`)); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { response.destroy(); reject(new Error('Tool response exceeds 1 MiB.')); } else chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('Tool response was interrupted.')));
      response.on('end', () => {
        try {
          let text = Buffer.concat(chunks).toString('utf8');
          if (credential) text = text.split(credential).join('[redacted]');
          resolve(JSON.parse(text));
        } catch { reject(new Error('Tool endpoint did not return JSON.')); }
      });
    });
    req.on('error', () => reject(new Error(signal.aborted ? 'Tool request canceled; external completion may be unknown.' : 'Could not connect to the tool endpoint.')));
    req.setTimeout(20_000, () => req.destroy(new Error('Timeout')));
    req.end(payload);
  });
}
export async function executeCustomTool(options: {
  run: DockerCommand; prefix: string[]; image: string; tool: CustomTool; args: unknown; signal: AbortSignal;
  credential?: ToolCredential; post?: typeof toolPost; valid?(): boolean;
}): Promise<unknown> {
  const { run, prefix, tool, signal } = options;
  const args = customToolArguments(tool, options.args);
  const assertValid = () => { signal.throwIfAborted(); if (!tool.enabled || options.valid?.() === false) throw new Error('Tool settings or permissions changed.'); };
  assertValid();
  const name = `cheshi-tool-${randomUUID()}`;
  let created = false;
  const stop = () => { if (created) void run([...prefix, 'container', 'rm', '--force', name]).catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    await run([...prefix, 'container', 'create', '--name', name, '--interactive', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--cpus', '1',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777', '--user', 'node', '--workdir', PACK_ROOT,
      '--entrypoint', tool.runtime, options.image, `${PACK_ROOT}/${tool.script}`]);
    created = true; assertValid();
    let output: string;
    try { output = await run([...prefix, 'container', 'start', '--attach', '--interactive', name], JSON.stringify(args)); }
    catch { throw new Error('Tool script failed. It must read JSON from stdin and write a JSON result to stdout.'); }
    assertValid();
    if (Buffer.byteLength(output) > 1024 * 1024) throw new Error('Tool result exceeds 1 MiB.');
    const status = (await run([...prefix, 'container', 'inspect', '--format', '{{.State.ExitCode}}', name])).trim();
    if (status !== '0') throw new Error('Tool script exited unsuccessfully.');
    let envelope: { result?: unknown; request?: { body?: unknown } };
    try { envelope = JSON.parse(output); } catch { throw new Error('Tool script did not return JSON.'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Invalid tool result envelope.');
    if (Object.hasOwn(envelope, 'result') && !Object.hasOwn(envelope, 'request')) return envelope.result;
    if (!envelope.request || Object.hasOwn(envelope, 'result') || !Object.hasOwn(envelope.request, 'body') || !tool.network) throw new Error('Expected result or an authorized endpoint request.');
    const url = publicToolUrl(tool.network.url);
    const credential = tool.network.credential ? await options.credential?.(url.origin, tool.network.credential) : null;
    if (tool.network.credential && !credential) throw new Error('Configure this tool’s API key on this computer.');
    assertValid();
    const result = await (options.post ?? toolPost)(url, envelope.request.body, credential ?? null, signal);
    assertValid(); return result;
  } finally {
    signal.removeEventListener('abort', stop);
    if (created) await run([...prefix, 'container', 'rm', '--force', name]).catch(() => {});
  }
}
