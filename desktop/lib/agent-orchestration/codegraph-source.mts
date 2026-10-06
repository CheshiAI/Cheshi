import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { codegraphArguments } from '../../../experiments/codex-specialists/src/codegraph-tools.ts';
import { codegraphFailure } from '../../../experiments/codex-specialists/src/codegraph-queue.ts';

export interface AgentCodeGraphOptions { cli: { executable: string; args: string[] }; dataRoot: string; beforeQuery?: (workspace: string, signal?: AbortSignal) => Promise<void> }
export type CodeGraphQuery = (workspace: string, tool: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
/** Use the same packaged CLI and central data root as SESSION; never load Bun SQLite in Electron. */
export function createAgentCodeGraph(options: AgentCodeGraphOptions): CodeGraphQuery {
  return async (workspace, tool, value, signal) => {
    const args = codegraphArguments(tool, value), root = await realpath(workspace);
    if (!isAbsolute(options.dataRoot)) throw new Error('An absolute CodeGraph data root is required.');
    signal.throwIfAborted();
    await options.beforeQuery?.(root, signal);
    signal.throwIfAborted();
    return new Promise(resolve => {
      const child = spawn(options.cli.executable, [...options.cli.args, 'codegraph', 'serve', '--mcp', '--path', root], {
        cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CODEGRAPH_DATA_ROOT: options.dataRoot,
          CHESHI_USER_DATA_DIR: options.dataRoot, CODEGRAPH_MCP_READ_ONLY: '1', NO_COLOR: '1' },
      });
      let settled = false, buffer = '';
      const finish = (result: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
        child.stdin.end(); child.kill('SIGTERM');
        const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
        kill.unref(); child.once('close', () => clearTimeout(kill));
        resolve(result);
      };
      const cancel = () => finish(codegraphFailure('CodeGraph query canceled or timed out. Use scoped project reads.'));
      const timer = setTimeout(cancel, 45_000);
      signal.addEventListener('abort', cancel, { once: true });
      const send = (message: unknown) => { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`); };
      child.once('error', () => finish(codegraphFailure('Could not start the project CodeGraph connection.')));
      child.stdin.on('error', () => finish(codegraphFailure('CodeGraph connection closed.')));
      child.once('exit', () => finish(codegraphFailure('CodeGraph is unavailable for this project. Use scoped source reads; do not create an index.')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: { id?: number; method?: string; error?: unknown; result?: unknown };
          try { message = JSON.parse(line); } catch { finish(codegraphFailure('Invalid CodeGraph response.')); return; }
          if (!message || typeof message !== 'object' || Array.isArray(message)) { finish(codegraphFailure('Invalid CodeGraph response.')); return; }
          if (message.method) {
            if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported request' } });
            continue;
          }
          if (message.error) { finish(codegraphFailure('CodeGraph query failed. Use scoped source reads.')); return; }
          if (message.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: { ...args, projectPath: root } } });
          } else if (message.id === 2) {
            const result = message.result as { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
            if (!Array.isArray(result?.content) || result.content.some(c => c.type !== 'text' || typeof c.text !== 'string')) {
              finish(codegraphFailure('Invalid CodeGraph tool result.')); return;
            }
            const mapped = { isError: result.isError === true, content: result.content.map(c => ({ type: 'text', text: c.text.replaceAll(root, '/workspace') })) };
            finish(mapped);
          }
        }
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cheshi-homie', version: '1' } } });
      if (signal.aborted) cancel();
    });
  };
}
