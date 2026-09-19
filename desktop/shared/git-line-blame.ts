export const MAX_BLAME_CONTENT_LENGTH = 2_000_000;
export interface GitLineBlameRequest { path: string; line: number; content: string }
export type GitLineBlame = { status: 'uncommitted' | 'unavailable' } | {
  status: 'committed'; hash: string; author: string; authoredAt: string; summary: string; originalLine: number; originalPath: string;
};
export type GitLineCommit = { status: 'uncommitted' | 'unavailable' } | {
  status: 'committed';
  blame: Extract<GitLineBlame, { status: 'committed' }>;
  message: string;
  messageTruncated: boolean;
  patch: string;
  truncated: boolean;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function gitLineBlameRequest(value: unknown): GitLineBlameRequest {
  const raw = object(value);
  if (!raw || typeof raw.path !== 'string' || !raw.path || raw.path.length > 4096
    || raw.path.startsWith('/') || raw.path.includes('\\') || /[\x00-\x1f]/u.test(raw.path)
    || raw.path.split('/').some(part => part === '..' || part === '.git' || !part)
    || typeof raw.content !== 'string' || raw.content.length > MAX_BLAME_CONTENT_LENGTH || raw.content.includes('\0')
    || typeof raw.line !== 'number' || !Number.isSafeInteger(raw.line) || raw.line < 1
    || raw.line > raw.content.split('\n').length) throw new TypeError('Invalid Git line history request.');
  return { path: raw.path, line: raw.line, content: raw.content };
}
export function gitLineBlame(value: unknown): GitLineBlame {
  const raw = object(value);
  if (raw?.status === 'uncommitted' || raw?.status === 'unavailable') return { status: raw.status };
  if (!raw || raw.status !== 'committed' || typeof raw.hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(raw.hash)
    || /^0+$/u.test(raw.hash) || typeof raw.author !== 'string' || raw.author.length > 1000
    || typeof raw.summary !== 'string' || raw.summary.length > 4000
    || typeof raw.authoredAt !== 'string' || !Number.isFinite(Date.parse(raw.authoredAt))
    || typeof raw.originalPath !== 'string' || !raw.originalPath || raw.originalPath.includes('\0')
    || typeof raw.originalLine !== 'number' || !Number.isSafeInteger(raw.originalLine) || raw.originalLine < 1) {
    throw new TypeError('Invalid Git line history response.');
  }
  return { status: 'committed', hash: raw.hash, author: raw.author, summary: raw.summary,
    authoredAt: raw.authoredAt, originalLine: raw.originalLine, originalPath: raw.originalPath };
}

export function gitLineCommit(value: unknown): GitLineCommit {
  const raw = object(value);
  if (raw?.status === 'uncommitted' || raw?.status === 'unavailable') return { status: raw.status };
  if (!raw || raw.status !== 'committed' || typeof raw.message !== 'string' || typeof raw.patch !== 'string'
    || typeof raw.truncated !== 'boolean' || typeof raw.messageTruncated !== 'boolean') {
    throw new TypeError('Invalid Git line commit response.');
  }
  const blame = gitLineBlame(raw.blame);
  if (blame.status !== 'committed') throw new TypeError('Missing Git line commit attribution.');
  return { status: 'committed', blame, message: raw.message, patch: raw.patch,
    truncated: raw.truncated, messageTruncated: raw.messageTruncated };
}
