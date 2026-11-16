import type { CodexAccountUsageStatus } from './codex-accounts.ts';

export interface ChatStatusDetails {
  version: string | null;
  server: string;
  provider: string | null;
  directory: string;
  permissionProfile: string;
  approvalPolicy: string | null;
  approvalsReviewer: string | null;
  instructionFiles: string[] | null;
  instructionNote: string;
  account: string | null;
  plan: string | null;
  usage: CodexAccountUsageStatus | null;
  warnings: string[];
}
