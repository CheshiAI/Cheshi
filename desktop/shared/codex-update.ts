export const CODEX_UPDATE_CHANNEL = 'cheshi:codex-update';
export const DEFAULT_WORKER_CODEX_VERSION = '0.163.0';
export const CODEX_UPDATE_STAGE_LABELS = {
  'checking-local': 'Checking local version…',
  'checking-release': 'Checking available version…',
  'checking-workers': 'Checking worker versions…',
  'waiting-lock': 'Waiting for worker access…',
  'updating-local': 'Updating local Codex…',
  'verifying-local': 'Verifying local Codex…',
  'preparing-worker': 'Preparing worker…',
  dependencies: 'Preparing worker dependencies…',
  'replacing-worker': 'Replacing worker…',
  'verifying-worker': 'Verifying worker…',
} as const;
export type CodexUpdateStage = keyof typeof CODEX_UPDATE_STAGE_LABELS;
export type CodexUpdateReporter = (stage?: CodexUpdateStage) => void;
export const CODEX_UPDATE_STALE_MS = 60_000;

export function codexVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) {
    throw new Error('Invalid Codex release version.');
  }
  return value;
}
export function parseCodexVersion(output: string): string {
  return codexVersion(/^codex-cli\s+(\S+)\s*$/m.exec(output)?.[1]);
}
export function newerCodexVersion(candidate: string, installed: string): boolean {
  const a = codexVersion(candidate).split('.').map(Number), b = codexVersion(installed).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
export interface CodexWorkerVersions {
  versions: string[];
  pending: number;
  waiting: number;
  errors: string[];
}
export interface CodexUpdateState {
  installedVersion: string | null;
  availableVersion: string | null;
  managed: boolean;
  busy: boolean;
  phase: 'checking' | 'idle' | 'local' | 'workers';
  workers: CodexWorkerVersions;
  detail: string;
  error: string | null;
  revision: number;
  localUpdated?: boolean;
  progress?: { stage: CodexUpdateStage; startedAt: number; updatedAt: number } | null;
}

export function codexUpdateDetail(state: CodexUpdateState): string {
  const { installedVersion, workers } = state;
  const versions = workers.versions.length > 0 && workers.versions.every(version => version === installedVersion)
    ? `Local and workers: ${installedVersion}.`
    : `Local: ${installedVersion ?? 'unknown'}. Workers: ${workers.versions.join(', ') || 'none'}.`;
  const status = workers.waiting > 0 ? 'Waiting for active tasks. Workers will update when those tasks finish.'
    : workers.pending ? 'Worker update available.'
    : state.managed ? '' : 'Codex is not managed by Homebrew. Worker versions can still be synchronized.';
  const guidance = state.localUpdated === true
    ? 'Existing local sessions keep their running process; new processes use the installed version.' : '';
  return [versions, status, guidance].filter(Boolean).join(' ');
}

export interface CodexUpdateApi {
  getCodexUpdate(): Promise<CodexUpdateState>;
  checkCodexUpdate(): Promise<CodexUpdateState>;
  installCodexUpdate(): Promise<CodexUpdateState>;
  syncWorkerCodex(): Promise<CodexUpdateState>;
  onCodexUpdateChanged(listener: (state: CodexUpdateState) => void): () => void;
}
