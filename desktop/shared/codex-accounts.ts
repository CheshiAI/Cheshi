import type { WorkspaceCodexLoginState } from './workspace-management.ts';

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimit {
  limitId: string;
  limitName: string | null;
  plan: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits?: CodexCredits;
}

export interface CodexCredits { balance: string | null; hasCredits: boolean; unlimited: boolean }

export function normalizeCodexCredits(value: unknown): CodexCredits | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.hasCredits !== 'boolean' || typeof entry.unlimited !== 'boolean') return undefined;
  return { balance: typeof entry.balance === 'string' ? entry.balance : null,
    hasCredits: entry.hasCredits, unlimited: entry.unlimited };
}

export interface CodexAccountUsageStatus {
  state: 'stopped' | 'starting' | 'ready' | 'login_required' | 'error';
  authenticated: boolean;
  plan: string | null;
  rateLimits: CodexRateLimit[];
  error: string | null;
}

export interface CodexAccountProfile {
  id: string;
  label: string;
  email: string | null;
  usage: CodexAccountUsageStatus;
  login: WorkspaceCodexLoginState;
}

export interface CodexAccountsSnapshot {
  activeId: string;
  profiles: CodexAccountProfile[];
}

export interface CodexAccountsApi {
  list(): Promise<CodexAccountsSnapshot>;
  add(): Promise<CodexAccountsSnapshot>;
  login(id: string): Promise<CodexAccountsSnapshot>;
  logout(id: string): Promise<CodexAccountsSnapshot>;
  cancelLogin(id: string): Promise<CodexAccountsSnapshot>;
  cancelRegistration(id: string): Promise<CodexAccountsSnapshot>;
  select(id: string): Promise<CodexAccountsSnapshot>;
  onDidChange(listener: (snapshot: CodexAccountsSnapshot) => void): () => void;
}

export const DEFAULT_CODEX_ACCOUNT_ID = 'default';
export const MAX_CODEX_ACCOUNT_PROFILES = 10;

export function isCodexAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
