import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexChatStatus } from '../lib/codex-chat-status.mts';
import { normalizeRateLimits } from '../lib/codex-account-service.mts';
import type { CodexChatClient } from '../lib/codex-chat-types.mts';
import type { ChatStatusDetails } from '../shared/chat-status';

async function fixture(run: (context: Parameters<typeof readCodexChatStatus>[0], calls: string[]) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'cheshi-status-'));
  await mkdir(join(cwd, '.git'));
  await writeFile(join(cwd, 'AGENTS.md'), 'Project instructions');
  const calls: string[] = [];
  const client: CodexChatClient = {
    initializeResult: { userAgent: 'cheshi/0.163.0 (Mac OS) dumb (cheshi; 0.0.0)', codexHome: join(cwd, 'home') },
    request: async (method, params, timeout) => {
      calls.push(method); expect(timeout).toBe(8000);
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' } };
      if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex', planType: 'pro',
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1792906140 },
        credits: { balance: '62500', hasCredits: true, unlimited: false } } };
      if (method === 'config/read') return { config: { model_provider: 'openai' } };
      if (method === 'thread/read') { expect(params).toEqual({ threadId: 'session-a', includeTurns: false }); return { thread: { cwd, modelProvider: 'session-provider' } }; }
      throw Error('Unexpected request');
    },
    respond: async () => {}, onNotification: () => () => {}, onRequest: () => () => {}, onDidFail: () => () => {},
  };
  const context = { client, cwd, getStatus: () => ({ threadId: 'session-a', model: 'selected-model' }),
    currentPermissionMode: () => ({ profileId: ':workspace' }),
    permissionOverrides: () => ({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }) };
  try { await run(context, calls); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('status reads the selected session and preserves runtime, account, limits and credits', async () => {
  await fixture(async (context, calls) => {
    const result = await readCodexChatStatus(context);
    const details = result.details as ChatStatusDetails;
    expect(result.model).toBe('selected-model');
    expect(details).toMatchObject({ version: '0.163.0', server: 'Local app server', provider: 'session-provider',
      directory: context.cwd, permissionProfile: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
      account: 'test@example.com', instructionFiles: [join(context.cwd, 'AGENTS.md')], warnings: [] });
    expect(details.instructionNote).toContain('does not report');
    expect(details.usage?.plan).toBe('pro');
    expect(details.usage?.rateLimits[0]?.secondary?.usedPercent).toBe(40);
    expect(details.usage?.rateLimits[0]?.credits?.balance).toBe('62500');
    expect(calls.sort()).toEqual(['account/rateLimits/read', 'account/read', 'config/read', 'thread/read']);
  });
});

test('failed usage reads remain unavailable while the remaining status survives', async () => {
  await fixture(async context => {
    const original = context.client.request;
    context.client.request = async (method, ...args) => {
      if (method === 'account/rateLimits/read') throw Error('Private backend detail');
      return original(method, ...args);
    };
    const details = (await readCodexChatStatus(context)).details as ChatStatusDetails;
    expect(details.usage).toBeNull();
    expect(details.version).toBe('0.163.0');
    expect(details.warnings).toEqual(['Usage details unavailable.']);
  });
});

test('a session switch cannot attach a previous session status to the new session', async () => {
  await fixture(async context => {
    let reads = 0;
    context.getStatus = () => ({ threadId: ++reads === 1 ? 'session-a' : 'session-b' });
    try { await readCodexChatStatus(context); throw Error('Expected a rejected status read'); }
    catch (error) { expect((error as Error).message).toContain('selected session changed'); }
  });
});

test('credit-only snapshots and literal flags survive normalization without invented balances', () => {
  expect(normalizeRateLimits({ rateLimits: { credits: { balance: '0', hasCredits: false, unlimited: false } } })[0]?.credits)
    .toEqual({ balance: '0', hasCredits: false, unlimited: false });
  expect(normalizeRateLimits({ rateLimits: { credits: { balance: null, hasCredits: true, unlimited: true } } })[0]?.credits?.unlimited).toBe(true);
  expect(normalizeRateLimits({ rateLimits: { credits: { hasCredits: 'true', unlimited: 1 } } })).toEqual([]);
});
