import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createCodeGraphSynchronization } from '../lib/codegraph-synchronization.mts';
import { createAgentCodeGraph } from '../lib/agent-orchestration/codegraph-source.mts';
import { CodeGraphIndexer } from '../lib/codegraph-service.mts';
import { codeGraphStorageDirectory } from '../../config/workspace-storage.mts';

test('SESSION and Homie searches see added, edited and removed symbols through one host owner', async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-sync-live-')));
  const root = join(temporary, 'project'), dataRoot = join(temporary, 'data');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"name":"sync-fixture","type":"module"}');
  writeFileSync(join(root, 'main.ts'), 'export function originalWidget() { return 1; }\n');
  const command = { executable: process.execPath, args: [resolve('cli/cheshi-cli.ts')] };
  const owner = createCodeGraphSynchronization({ command, dataRoot });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new CodeGraphIndexer({ command }).initialize(root, dataRoot);
    const connection = await owner.connection(root);
    child = spawn(command.executable, [...command.args, 'codegraph', 'serve', '--mcp', '--path', root], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEGRAPH_DATA_ROOT: dataRoot,
        CODEGRAPH_MCP_READ_ONLY: '1', CHESHI_CODEGRAPH_SYNC_URL: connection.url,
        CHESHI_CODEGRAPH_SYNC_TOKEN: connection.token, CHESHI_CODEGRAPH_SYNC_WORKSPACE: root },
    });
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let sequence = 0, stderr = '';
    child.stderr!.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (message.id === undefined) return;
      const request = pending.get(message.id); pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    });
    child.on('exit', () => { for (const request of pending.values()) request.reject(new Error(stderr || 'MCP exited')); });
    const request = (method: string, params: unknown) => new Promise<unknown>((accept, reject) => {
      const id = ++sequence; pending.set(id, { resolve: accept, reject });
      child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sync-test', version: '1' } });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const search = async (query: string) => {
      const result = await request('tools/call', { name: 'codegraph_search', arguments: { query } }) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).not.toBe(true);
      return result.content.map(item => item.text).join('\n');
    };
    expect(await search('originalWidget')).toContain('originalWidget');
    const marker = join(codeGraphStorageDirectory(dataRoot, root), 'codegraph.db.initializing');
    writeFileSync(marker, 'incomplete');
    const unavailable = await request('tools/call', { name: 'codegraph_search', arguments: { query: 'originalWidget' } }) as { isError?: boolean };
    expect(unavailable.isError).toBe(true);
    unlinkSync(marker);
    writeFileSync(join(root, 'main.ts'), 'export function updatedWidget() { return 222; }\n');
    writeFileSync(join(root, 'extra.ts'), 'export function addedWidget() { return 3; }\n');
    expect(await search('updatedWidget')).toContain('updatedWidget');
    expect(await search('originalWidget')).not.toContain('main.ts');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'child.ts'), 'export function nestedWidget() { return 4; }\n');
    const nested = await request('tools/call', { name: 'codegraph_search', arguments: { query: 'nestedWidget', projectPath: join(root, 'nested') } }) as { isError?: boolean; content: { text: string }[] };
    expect(nested.isError).not.toBe(true);
    expect(nested.content.map(item => item.text).join('\n')).toContain('child.ts');
    const query = createAgentCodeGraph({ cli: command, dataRoot, beforeQuery: owner.ensure });
    const added = await query(root, 'codegraph_search', { query: 'addedWidget' }, new AbortController().signal) as { isError?: boolean; content: { text: string }[] };
    expect(added.isError).not.toBe(true);
    expect(added.content.map(item => item.text).join('\n')).toContain('addedWidget');
    unlinkSync(join(root, 'extra.ts'));
    const removed = await search('addedWidget');
    expect(removed).not.toContain('extra.ts');
    // The original SESSION connection stays open across every host write.
    expect(child.exitCode).toBeNull();
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>(accept => child!.once('exit', () => accept()));
      child.kill('SIGTERM'); await exited;
    }
    await owner.dispose();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 90_000);
