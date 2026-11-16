import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ChatStatusDetails } from '../shared/chat-status.ts';
import type { CodexChatClient, JsonObject } from './codex-chat-types.mts';
import { normalizeRateLimits } from './codex-account-service.mts';
import { recordValue, stringValue } from './codex-service-utils.mts';

async function exists(path: string, file = false): Promise<boolean> {
  try { const entry = await stat(path); return !file || entry.isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
}

/** Only report files found on disk; the protocol does not attest which instructions a session loaded. */
async function instructionFiles(cwd: string, home: string | null, config: JsonObject | null): Promise<string[]> {
  if (config?.project_doc_max_bytes === 0) return [];
  const chain = [resolve(cwd)];
  while (dirname(chain[0]!) !== chain[0] && !await exists(join(chain[0]!, '.git'))) chain.unshift(dirname(chain[0]!));
  const names = ['AGENTS.override.md', 'AGENTS.md', ...(Array.isArray(config?.project_doc_fallback_filenames)
    ? config.project_doc_fallback_filenames.filter((name): name is string => typeof name === 'string' && basename(name) === name) : [])];
  const files: string[] = [];
  for (const directory of [...new Set([...(home ? [home] : []), ...chain])]) {
    for (const name of names) {
      const path = join(directory, name);
      if (await exists(path, true)) { files.push(path); break; }
    }
  }
  return files;
}

export async function readCodexChatStatus(context: {
  client: CodexChatClient; cwd: string;
  getStatus(): JsonObject;
  currentPermissionMode(): { profileId: string };
  permissionOverrides(): JsonObject;
}): Promise<JsonObject> {
  const base = context.getStatus();
  const threadId = stringValue(base.threadId);
  const warnings: string[] = [];
  const requests = [
    ['Account', 'account/read', {}],
    ['Usage', 'account/rateLimits/read', {}],
    ['Configuration', 'config/read', { cwd: context.cwd, includeLayers: false }],
    ...(threadId ? [['Session', 'thread/read', { threadId, includeTurns: false }]] : []),
  ] as const;
  const results = await Promise.allSettled(requests.map(([, method, params]) => context.client.request(String(method), params, 8_000)));
  const data = results.map((result, index) => {
    if (result.status === 'fulfilled' && recordValue(result.value)) return recordValue(result.value);
    warnings.push(`${requests[index]![0]} details unavailable.`);
    return null;
  });
  if (context.getStatus().threadId !== base.threadId) throw new Error('The selected session changed. Open status again.');
  const [accountResponse, usageResponse, configResponse, threadResponse] = data;
  const account = recordValue(accountResponse?.account);
  const config = recordValue(configResponse?.config);
  const thread = recordValue(threadResponse?.thread);
  const initialization = context.client.initializeResult;
  const userAgent = stringValue(initialization?.userAgent);
  const overrides = context.permissionOverrides();
  const limits = usageResponse ? normalizeRateLimits(usageResponse) : [];
  const directory = stringValue(thread?.cwd) ?? context.cwd;
  let files: string[] | null = null;
  try { files = await instructionFiles(directory, stringValue(initialization?.codexHome), config); }
  catch { warnings.push('Instruction file discovery unavailable.'); }
  const details: ChatStatusDetails = {
    // The server uses the caller's name in this token, but its own runtime version.
    version: userAgent?.match(/^[^\s/]+\/(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null,
    server: 'Local app server',
    // https://learn.chatgpt.com/docs/config-file/config-reference: model_provider defaults to openai.
    provider: stringValue(thread?.modelProvider) ?? stringValue(config?.model_provider) ?? (config ? 'openai' : null),
    directory,
    permissionProfile: context.currentPermissionMode().profileId,
    approvalPolicy: stringValue(overrides.approvalPolicy) ?? stringValue(config?.approval_policy),
    approvalsReviewer: stringValue(overrides.approvalsReviewer) ?? stringValue(config?.approvals_reviewer),
    instructionFiles: files,
    instructionNote: config?.project_doc_max_bytes === 0 ? 'Project instruction loading is disabled.'
      : 'Files found on disk. Codex does not report the instruction files loaded by this session.',
    account: stringValue(account?.email) ?? (account?.type === 'apiKey' ? 'API key' : null),
    plan: stringValue(account?.planType) ?? limits.find(limit => limit.plan)?.plan ?? null,
    usage: usageResponse ? { state: 'ready', authenticated: account !== null,
      plan: stringValue(account?.planType) ?? limits.find(limit => limit.plan)?.plan ?? null,
      rateLimits: limits, error: null } : null,
    warnings,
  };
  return { ...base, details };
}
