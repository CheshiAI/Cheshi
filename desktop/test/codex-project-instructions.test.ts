import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccountClients } from '../lib/codex-account-clients.mts';
import { parseRuntimeConfiguration } from '../../experiments/codex-specialists/src/runtime-config.ts';
import { AppServerClient } from '../../experiments/codex-specialists/src/app-server-client.ts';

interface ProbeClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Native instruction discovery only: no credentials, provider calls, or model turns. */
for (const runtime of ['session', 'homie'] as const) for (const limit of [undefined, 131072]) {
  test.skipIf(!Bun.which('codex'))(`${runtime} applies ${limit ?? 32768} bytes on start and resume`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cheshi-project-rules-')));
    const home = join(root, 'codex'), workspace = join(root, 'project'), nested = join(workspace, 'nested');
    mkdirSync(home); mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '--quiet', workspace]);
    const configuration = 'project_doc_max_bytes = 32768\n';
    writeFileSync(join(home, 'config.toml'), configuration);
    const rootRules = `# Root rules\n${'Root guidance.\n'.repeat(1800)}ROOT_RULES_END\n`;
    const nestedRules = `# Nested rules\n${'Nested guidance.\n'.repeat(1600)}NESTED_RULES_END\n`;
    writeFileSync(join(workspace, 'AGENTS.md'), rootRules);
    writeFileSync(join(nested, 'AGENTS.md'), nestedRules);
    expect(Buffer.byteLength(rootRules + nestedRules)).toBeGreaterThan(32768);
    const environment = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home };
    let client: ProbeClient | undefined;
    try {
      if (runtime === 'session') {
        const pool = new CodexAccountClients(environment, undefined, limit === undefined ? undefined : () => limit);
        const transport = pool.create({ command: { executable: Bun.which('codex')!,
          args: ['app-server', '--listen', 'stdio://'], environment: {} }, cwd: workspace,
          capabilities: { experimentalApi: true }, clientInfo: { name: 'instruction-test', title: 'Instruction test', version: '1' } });
        client = { request: (method, params) => transport.request(method, params), close: () => pool.stop() };
      } else {
        const transport = new AppServerClient(Bun.which('codex')!, environment, undefined, limit);
        client = transport;
        await transport.initialize();
      }
      const config = await client.request('config/read', { includeLayers: false }) as { config: { project_doc_max_bytes: number } };
      expect(config.config.project_doc_max_bytes).toBe(limit ?? 32768);
      const params = { cwd: nested, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: 'Local discovery test.' };
      const started = await client.request('thread/start', params) as { thread: { id: string; path: string }; instructionSources: string[] };
      expect(started.instructionSources).toContain(join(workspace, 'AGENTS.md'));
      expect(started.instructionSources).toContain(join(nested, 'AGENTS.md'));
      const persistAndRead = async () => {
        await client!.request('thread/inject_items', { threadId: started.thread.id, items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Local probe; do not invoke a model.' }] },
        ] });
        await client!.request('thread/unsubscribe', { threadId: started.thread.id });
        const rows = readFileSync(started.thread.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        return rows.flatMap(row => row.type === 'response_item' && row.payload?.role === 'user' ? row.payload.content ?? [] : [])
          .map((item: { text?: string }) => item.text ?? '').filter((text: string) => text.startsWith('# AGENTS.md instructions')).at(-1) ?? '';
      };
      for (const stage of ['start', 'resume']) {
        if (stage === 'resume') await client.request('thread/resume', { ...params, threadId: started.thread.id });
        const instructions = await persistAndRead();
        expect(instructions).toContain(rootRules.trim());
        if (limit === 131072) expect(instructions).toContain(nestedRules.trim());
        else { expect(instructions).toContain('# Nested rules'); expect(instructions).not.toContain('NESTED_RULES_END'); }
      }
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(configuration);
    } finally {
      try { await client?.close(); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 30000);
}


test('worker configuration defaults to 32 KiB and validates a saved instruction limit', () => {
  const config = { profileId: 'test', accountId: 'test', role: 'development', token: 'a'.repeat(64), instructions: 'Test.',
    model: null, reasoningEffort: null, serviceTier: null, permissions: { fileWrite: false, commandExecution: false } };
  expect(parseRuntimeConfiguration(config).projectDocMaxBytes).toBe(32768);
  expect(parseRuntimeConfiguration({ ...config, projectDocMaxBytes: 131072 }).projectDocMaxBytes).toBe(131072);
  for (const value of [null, '131072', false, 0, 1025]) {
    expect(() => parseRuntimeConfiguration({ ...config, projectDocMaxBytes: value })).toThrow('whole number');
  }
});
