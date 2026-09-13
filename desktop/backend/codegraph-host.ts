import { existsSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';

const projectRoot = process.argv[2]?.trim();
const staticRoot = process.argv[3]?.trim();
const configuredPortValue = process.env.CHESHI_VIEWER_API_PORT?.trim();
const apiOnly = process.env.CHESHI_VIEWER_API_ONLY === '1';

if (!projectRoot || !path.isAbsolute(projectRoot)) {
  process.stderr.write('codegraph-host requires an absolute project path.\n');
  process.exit(2);
}
if (!staticRoot || !path.isAbsolute(staticRoot)) {
  process.stderr.write('codegraph-host requires an absolute frontend asset path.\n');
  process.exit(2);
}
const configuredPort = configuredPortValue ? Number(configuredPortValue) : null;
if (configuredPort !== null && (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535)) {
  process.stderr.write('CHESHI_VIEWER_API_PORT must be an integer between 1 and 65535.\n');
  process.exit(2);
}

const adjacentTreeSitterWasm = path.join(path.dirname(process.execPath), 'tree-sitter.wasm');
if (!process.env.CODEGRAPH_TREE_SITTER_WASM && existsSync(adjacentTreeSitterWasm)) {
  process.env.CODEGRAPH_TREE_SITTER_WASM = adjacentTreeSitterWasm;
}

const port = configuredPort ?? await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') {
      probe.close();
      reject(new Error('Could not allocate a local CodeGraph server port.'));
      return;
    }
    probe.close((error) => {
      if (error) reject(error);
      else resolve(address.port);
    });
  });
});

const { startCodeGraphServer } = await import('@cheshi/codegraph-server');
const server = await startCodeGraphServer(projectRoot, {
  hostname: '127.0.0.1',
  port,
  serveStatic: !apiOnly,
  staticRoot,
});

process.stdout.write(`${JSON.stringify({ type: 'ready', url: server.url })}\n`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  server.close();
  process.exit(0);
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.stdin.once('end', stop);
process.stdin.resume();
