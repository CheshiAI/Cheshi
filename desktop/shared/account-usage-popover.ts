import type { CodexAccountsSnapshot } from './codex-accounts.ts';
import type { WindowAppearanceState } from './window-appearance.ts';
import type { SchedulerSummary } from './scheduler.ts';

export const USAGE_POPOVER_CHANNEL = 'cheshi:usage-popover';

export interface UsagePopoverState {
  revision: number;
  snapshot: CodexAccountsSnapshot | null;
  dark: boolean;
  appearance: WindowAppearanceState | null;
  scheduler?: SchedulerSummary;
}

export interface UsagePopoverApi {
  read(): Promise<UsagePopoverState>;
  onChange(listener: (state: UsagePopoverState) => void): () => void;
  resize(height: number): Promise<void>;
  action(action: 'show' | 'quit' | 'close' | 'scheduler'): Promise<void>;
}

declare global {
  interface Window { cheshiUsagePopover?: UsagePopoverApi }
}
